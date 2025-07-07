const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Load .env.json for local development
let env = {};
try {
  env = JSON.parse(fs.readFileSync(path.join(__dirname, '.env.json'), 'utf8'));
} catch (e) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('Could not load .env.json:', e.message);
  }
}
const getEnv = (key) => env[key] || process.env[key];

// Cache for secrets loaded from AWS Secrets Manager
let cachedSecrets = null;
let cachedSecretFetchTime = 0;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getSecrets() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Running in AWS Lambda: load from Secrets Manager
    const now = Date.now();
    if (cachedSecrets && (now - cachedSecretFetchTime < SECRET_CACHE_TTL_MS)) {
      return cachedSecrets;
    }
    const secretId = getEnv('SECRET_ID');
    const client = new SecretsManagerClient();
    const command = new GetSecretValueCommand({ SecretId: secretId });
    const response = await client.send(command);
    cachedSecrets = JSON.parse(response.SecretString);
    cachedSecretFetchTime = now;
    return cachedSecrets;
  } else {
    // Local dev: use .env.json
    return env;
  }
}

// SKU prefix lists
const SKU_PREFIXES_A = ['Arace-', 'DQ-'];
const SKU_PREFIXES_B = ['DJI'];

// Helper to refresh ClickUp access token using OAuth2 refresh token
async function getClickUpAccessToken(secrets) {
  const clientId = secrets.CLICKUP_CLIENT_ID;
  const clientSecret = secrets.CLICKUP_CLIENT_SECRET;
  const refreshToken = secrets.CLICKUP_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing ClickUp OAuth2 credentials in secrets');
  }
  const response = await axios.post('https://api.clickup.com/api/v2/oauth/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  return response.data.access_token;
}

function verifyHubspotSignature(secret, body, signature) {
  const hash = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return hash === signature;
}

function matchesPrefix(sku, prefixes) {
  return prefixes.some(prefix => sku && sku.startsWith(prefix));
}

exports.handler = async (event) => {
  const start = Date.now();
  try {
    // Route based on HTTP method and path
    const route = event.requestContext && event.requestContext.http && event.requestContext.http.path;
    const method = event.requestContext && event.requestContext.http && event.requestContext.http.method;

    // Handle ClickUp OAuth2 callback (GET)
    if (method === 'GET' && route && route.endsWith('/clickup/oauth/callback')) {
      const query = event.queryStringParameters || {};
      const code = query.code;
      if (!code) {
        return { statusCode: 400, body: 'Missing code parameter' };
      }
      // Exchange code for access token
      const secrets = await getSecrets();
      const clientId = secrets.CLICKUP_CLIENT_ID;
      const clientSecret = secrets.CLICKUP_CLIENT_SECRET;
      const redirectUri = getEnv('CLICKUP_REDIRECT_URI');
      try {
        const resp = await axios.post('https://api.clickup.com/api/v2/oauth/token', {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri
        });
        // TODO: Securely store resp.data.access_token and resp.data.refresh_token for the user/account.
        // In production, do NOT return tokens in the response. Store them in a secure store (e.g., Secrets Manager, DynamoDB, or encrypted DB).
        // For demo, just return them (DO NOT do this in production)
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: 'OAuth2 token exchange successful',
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token
          })
        };
      } catch (err) {
        return { statusCode: 500, body: 'OAuth2 token exchange failed: ' + err.toString() };
      }
    }

    // Load secrets/config from AWS Secrets Manager or .env.json
    const secrets = await getSecrets();
    const HUBSPOT_ACCESS_TOKEN = secrets.HUBSPOT_ACCESS_TOKEN;
    const CLICKUP_FOLDER_ID_A = getEnv('CLICKUP_FOLDER_ID_A');
    const CLICKUP_TEMPLATE_ID_A = getEnv('CLICKUP_TEMPLATE_ID_A');
    const CLICKUP_FOLDER_ID_B = getEnv('CLICKUP_FOLDER_ID_B');
    const CLICKUP_TEMPLATE_ID_B = getEnv('CLICKUP_TEMPLATE_ID_B');

    // 1. Verify HMAC (optional, only if you set up webhook signing)
    // const signature = event.headers['X-HubSpot-Signature'] || event.headers['x-hubspot-signature'];
    // if (!signature) {
    //   return { statusCode: 401, body: 'Missing signature' };
    // }
    // const rawBody = event.body;
    // if (!verifyHubspotSignature(HUBSPOT_CLIENT_SECRET, rawBody, signature)) {
    //   return { statusCode: 401, body: 'Invalid signature' };
    // }

    // 2. Parse webhook events
    const rawBody = event.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const events = Array.isArray(body) ? body : (body.events || []);
    const hubspotBase = 'https://api.hubapi.com';
    const clickupBase = 'https://api.clickup.com/api/v2';
    let triggered = false;
    // Get a fresh ClickUp access token for this invocation
    const CLICKUP_ACCESS_TOKEN = await getClickUpAccessToken(secrets);
    for (const eventObj of events) {
      if (eventObj.propertyName === 'dealstage' && eventObj.value === 'closedwon') {
        // GET deal with associations
        const dealId = eventObj.objectId || eventObj.dealId || eventObj.id;
        if (!dealId) continue;
        const dealResp = await axios.get(`${hubspotBase}/crm/v3/objects/deals/${dealId}`, {
          params: {
            associations: 'line_items,contacts,companies',
            properties: 'dealname,close_date',
            archived: false
          },
          headers: { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` }
        });
        const deal = dealResp.data;
        const lineItems = (deal.associations?.line_items?.results || []);
        let matchType = null;
        // Check all line items for prefix matches
        for (const item of lineItems) {
          const itemId = item.id || item;
          const itemResp = await axios.get(`${hubspotBase}/crm/v3/objects/line_items/${itemId}`, {
            headers: { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` }
          });
          const sku = itemResp.data.properties?.name || '';
          if (matchesPrefix(sku, SKU_PREFIXES_A)) {
            matchType = 'A';
            break;
          } else if (matchesPrefix(sku, SKU_PREFIXES_B)) {
            matchType = matchType || 'B'; // Only set to B if not already A
          }
        }
        if (matchType && !triggered) {
          // Get customer, primary_contact, close_date
          const customer = (deal.associations?.companies?.results?.[0]?.id) || '';
          const primaryContact = (deal.associations?.contacts?.results?.[0]?.id) || '';
          const closeDate = deal.properties?.close_date || '';
          let clickupUrl, payload;
          if (matchType === 'A') {
            clickupUrl = `${clickupBase}/folder/${CLICKUP_FOLDER_ID_A}/list_template/${CLICKUP_TEMPLATE_ID_A}?return_immediately=true`;
          } else if (matchType === 'B') {
            clickupUrl = `${clickupBase}/folder/${CLICKUP_FOLDER_ID_B}/list_template/${CLICKUP_TEMPLATE_ID_B}?return_immediately=true`;
          }
          payload = {
            name: deal.properties?.dealname || 'New Deal',
            custom_fields: [
              { name: 'customer', value: customer },
              { name: 'primary_contact', value: primaryContact },
              { name: 'close_date', value: closeDate }
            ]
          };
          // Fire and forget
          axios.post(clickupUrl, payload, {
            headers: { Authorization: CLICKUP_ACCESS_TOKEN, 'Content-Type': 'application/json' }
          });
          triggered = true; // Only trigger once per deal
        }
      }
      // Check for timeout (return quickly)
      if (Date.now() - start > 4000) break;
    }
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error(err);
    return { statusCode: 200, body: 'ok' };
  }
};

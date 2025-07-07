# hubspot-clickup-bridge

This project is an AWS SAM (Serverless Application Model) application for handling HubSpot webhooks and bridging them to ClickUp. It supports secure token management, OAuth2 for ClickUp, and dynamic deal processing based on SKU prefixes.

## Project Structure

- **Runtime:** nodejs18.x
- **Function File:** `hello-world/index.js` (main Lambda handler)
- **API Endpoints:**
  - **POST** `/hubspot/webhook` — Receives webhook events from HubSpot (e.g., deal closed events)
  - **GET** `/clickup/oauth/callback` — Handles ClickUp OAuth2 callback and exchanges code for tokens
- **IAM Policy:** Least-privilege (only Secrets Manager access by default)
- **Secrets:** Managed in AWS Secrets Manager (see below)
- **Environment Variables:** Used for ClickUp folder/template IDs and redirect URIs

## Deployment

1. Install the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
2. Build your application:
   ```bash
   sam build
   ```
3. Deploy your application:
   ```bash
   sam deploy --guided
   ```
   After deployment, note the CloudFormation outputs for your API endpoints.

## API

- **POST /hubspot/webhook**
  - Receives webhook events from HubSpot. Triggers on deal property changes (e.g., `reason_won` or `dealstage`).
  - Processes deals, fetches details, and creates ClickUp lists based on SKU prefix allowlists.
- **GET /clickup/oauth/callback**
  - Handles ClickUp OAuth2 callback. Exchanges the code for access/refresh tokens.
  - **Important:** In production, tokens should be securely stored (e.g., in DynamoDB or Secrets Manager). The demo code returns them in the response for testing only.

## How to Test

- **HubSpot Trigger:**
  - Register the `/hubspot/webhook` endpoint as a webhook in HubSpot.
  - You can change the trigger property (e.g., use `reason_won` and make it mandatory on deal close).
  - Move a deal to closed (with the required property) to trigger the Lambda.
- **ClickUp OAuth:**
  - Set the `/clickup/oauth/callback` endpoint as your ClickUp app's redirect URI.
  - Complete the OAuth flow to generate tokens. Check Lambda logs or the HTTP response for the token exchange result.

## Secrets & Environment

- Store sensitive values (API keys, client secrets, refresh tokens) in AWS Secrets Manager under the secret name specified by `SECRET_ID`.
- Use environment variables for non-secret config (ClickUp folder/template IDs, redirect URIs).
- For local testing, use a `.env.json` file in `hello-world/`.

## Lessons Learned

- **IAM Permissions:** Ensure your deployer IAM user has all required permissions (CloudFormation, S3, IAM, Lambda, etc.).
- **CloudFormation Rollbacks:** If a stack fails, you may need to manually empty S3 buckets or delete failed stacks.
- **Webhook Testing:** HubSpot webhooks can be tested by moving deals to closed and ensuring required properties are set.
- **Token Security:** Never return OAuth tokens in HTTP responses in production. Store them securely.
- **API Gateway Outputs:** Add explicit outputs for all endpoints you need to reference post-deployment.

## Best Practices & Next Steps

- **Secure Token Storage:** Implement secure storage for ClickUp tokens (e.g., DynamoDB or Secrets Manager per user/account).
- **Monitoring:** Use CloudWatch Logs to monitor Lambda execution and troubleshoot issues.
- **Cost Management:** Minimal cost for low-volume usage (see AWS Lambda and API Gateway pricing).
- **Extensibility:** To add more triggers or integrations, update the Lambda handler and `template.yaml`.
- **Documentation:** Keep this README and `template.yaml` up to date with any changes.

## Contributing

- Update the README and relevant files with every change.
- Document any new endpoints, environment variables, or secrets required.
- Test all integrations after deployment.

---

Generated and maintained with AWS SAM CLI.

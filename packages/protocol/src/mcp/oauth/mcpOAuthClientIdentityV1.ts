import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { HAPPIER_HOSTED_WEBAPP_URL_V1 } from '../../server/urls/hostedWebappUrl.js';
import { z } from '../../zodRuntimePolicy.js';

/** A person-supplied app; null asks discovery to remove the current issuer's registration. */
export const McpOAuthClientRegistrationV1Schema = z.nullable(z.strictObject({
    clientId: z.string().check(z.trim(), z.minLength(1)),
    clientSecret: z.optional(z.string().check(z.minLength(1))),
}));
export type McpOAuthClientRegistrationV1 = z.infer<typeof McpOAuthClientRegistrationV1Schema>;

/** Hosted client identity (Client ID Metadata Document); `apps/ui/public/oauth/mcp/client-metadata.json` publishes it. */
export const MCP_OAUTH_CLIENT_METADATA_URL_V1 = `${HAPPIER_HOSTED_WEBAPP_URL_V1}/oauth/mcp/client-metadata.json`;
export const MCP_OAUTH_CALLBACK_URL_V1 = `${HAPPIER_HOSTED_WEBAPP_URL_V1}/oauth/mcp/callback`;
export const MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 = HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1;

import { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import { completeConnectedAccountOAuthCallback, type ConnectedAccountOAuthCallbackProtocol, type ConnectedAccountOAuthCallbackInput, type ConnectedAccountOAuthCallbackOutcome } from './connectedAccountOAuthCallback';

/** The only origin the callback page posts to, and the only origin an opener accepts it from (C34). */
export const MCP_OAUTH_CALLBACK_ORIGIN = new URL(MCP_OAUTH_CALLBACK_URL_V1).origin;
export const MCP_OAUTH_OPENER_MESSAGE_TYPE = 'happier.mcp.oauth';

export type McpOAuthOpenerMessage = Readonly<{ type: typeof MCP_OAUTH_OPENER_MESSAGE_TYPE; code: string; state: string; iss?: string }>;

/** Reads an opener message posted by the callback page; anything else (another origin, another shape) is `null`. */
export function readMcpOAuthOpenerMessage(event: Readonly<{ origin: string; data: unknown }>): McpOAuthOpenerMessage | null {
    if (event.origin !== MCP_OAUTH_CALLBACK_ORIGIN) return null;
    const data = event.data as Partial<Record<string, unknown>> | null;
    if (!data || typeof data !== 'object' || data.type !== MCP_OAUTH_OPENER_MESSAGE_TYPE) return null;
    if (typeof data.code !== 'string' || !data.code || typeof data.state !== 'string' || !data.state) return null;
    if (data.iss !== undefined && typeof data.iss !== 'string') return null;
    return { type: MCP_OAUTH_OPENER_MESSAGE_TYPE, code: data.code, state: data.state, ...(data.iss === undefined ? {} : { iss: data.iss as string }) };
}

export const MCP_OAUTH_CALLBACK_PROTOCOL: ConnectedAccountOAuthCallbackProtocol = {
    callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
    openerMessageType: MCP_OAUTH_OPENER_MESSAGE_TYPE,
    service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
    pendingProviderPrefix: 'mcp:',
    connectedReturnPath: account => `/settings/mcp/${encodeURIComponent(account.accountId)}`,
};

export type McpOAuthCallbackInput = ConnectedAccountOAuthCallbackInput;
export type McpOAuthCallbackOutcome = ConnectedAccountOAuthCallbackOutcome;

/** MCP retains its protocol identity; the shared controller owns all relay mechanics. */
export function completeMcpOAuthCallback(input: McpOAuthCallbackInput): Promise<McpOAuthCallbackOutcome> {
    return completeConnectedAccountOAuthCallback(input, MCP_OAUTH_CALLBACK_PROTOCOL);
}

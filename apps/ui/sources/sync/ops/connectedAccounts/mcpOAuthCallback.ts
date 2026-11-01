import { parseOauthAuthorizationResponse } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import type { ConnectedAccountAttemptResponse } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import type { runConnectedAccountAuthenticationAction } from './connectedAccountDaemon';

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

export type McpOAuthCallbackInput = Readonly<{
    callbackUrl: string;
    browser?: Readonly<{
        replaceUrl(path: string): void;
        close(): void;
        opener?: Readonly<{ origin?: string; postMessage(message: unknown, origin: string): void }>;
    }>;
    account?: Readonly<{
        serverId: string;
        expectedAccountId: string;
        assertCurrent(): void;
        readMachines(): Promise<readonly Parameters<typeof isMachineReachable>[1][]>;
        executeAction?: Parameters<typeof runConnectedAccountAuthenticationAction>[0]['executeAction'];
        returnTo?: string;
        machineId?: string;
        signal?: AbortSignal;
    }>;
}>;

export type McpOAuthCallbackOutcome =
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'opener' }>
    | Readonly<{ kind: 'paste'; callbackUrl: string }>
    | Readonly<{ kind: 'connected'; machineId: string; returnTo: string }>
    | Readonly<{ kind: 'unfinished'; machineId: string; response: ConnectedAccountAttemptResponse }>;

/** Callback routing only; the daemon owns full-state, PKCE and issuer validation. */
export async function completeMcpOAuthCallback(input: McpOAuthCallbackInput): Promise<McpOAuthCallbackOutcome> {
    const response = parseOauthAuthorizationResponse({ input: input.callbackUrl, redirectUri: MCP_OAUTH_CALLBACK_URL_V1 });
    input.browser?.replaceUrl('/oauth/mcp/callback');
    if (response.kind !== 'callback' || !response.code || !response.state || response.error) return { kind: 'invalid' };
    // The nonce is base64url (no dots); attempt ids themselves may contain dots.
    const separator = response.state.lastIndexOf('.');
    if (separator <= 0 || separator === response.state.length - 1) return { kind: 'invalid' };
    const attemptId = response.state.slice(0, separator);
    const completion = { code: response.code, state: response.state, callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
        ...(response.iss === undefined ? {} : { iss: response.iss }) };
    const paste = { kind: 'paste' as const, callbackUrl: input.callbackUrl };
    if (input.browser?.opener) {
        if (input.browser.opener.origin !== MCP_OAUTH_CALLBACK_ORIGIN) return paste;
        const message: McpOAuthOpenerMessage = { type: MCP_OAUTH_OPENER_MESSAGE_TYPE, code: response.code, state: response.state,
            ...(response.iss === undefined ? {} : { iss: response.iss }) };
        input.browser.opener.postMessage(message, MCP_OAUTH_CALLBACK_ORIGIN);
        input.browser.close();
        return { kind: 'opener' };
    }
    const account = input.account;
    if (!account) return paste;
    const assertCurrent = () => { account.signal?.throwIfAborted(); account.assertCurrent(); };
    assertCurrent();
    let machineId = account.machineId;
    if (!machineId) {
        const machines = await account.readMachines();
        assertCurrent();
        if (!machines.length) return paste;
        const { isMachineReachable } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { listPendingConnectedAccountAuthenticationActions } = await import('./connectedAccountDaemon');
        assertCurrent();
        const scope = { serverId: account.serverId, accountId: account.expectedAccountId };
        for (const machine of machines) {
            if (!isMachineReachable(scope, machine)) continue;
            const pending = await listPendingConnectedAccountAuthenticationActions({ serverId: account.serverId,
                expectedAccountId: account.expectedAccountId, machineId: machine.id, assertCurrent,
                service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, executeAction: account.executeAction, signal: account.signal });
            assertCurrent();
            if (pending.status === 'pendingAttempts' && pending.attempts.some(attempt => attempt.attemptId === attemptId && attempt.kind === 'oauth')) {
                machineId = machine.id;
                break;
            }
        }
        if (!machineId) return paste;
    }
    const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
    assertCurrent();
    const target = { serverId: account.serverId, expectedAccountId: account.expectedAccountId, machineId,
        assertCurrent, executeAction: account.executeAction, signal: account.signal };
    const restored = await runConnectedAccountAuthenticationAction({ ...target, command: { operation: 'read', attemptId } });
    assertCurrent();
    const settled = restored.status === 'awaitingOAuth' && restored.callbackUrl === MCP_OAUTH_CALLBACK_URL_V1
        ? await runConnectedAccountAuthenticationAction({ ...target, command: { operation: 'completeOAuth', attemptId, completion } })
        : restored;
    assertCurrent();
    if (settled.status !== 'connected' || settled.account.service.pluginId !== MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.pluginId
        || settled.account.service.localId !== MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.localId) {
        return { kind: 'unfinished', machineId, response: settled };
    }
    const { normalizeInternalReturnPath } = await import('@/utils/path/routeUtils');
    assertCurrent();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const pending = await TokenStorage.getPendingExternalConnect();
    assertCurrent();
    const matches = pending?.provider === `mcp:${attemptId}` && pending.serverId === account.serverId;
    const retainedReturn = matches ? normalizeInternalReturnPath(pending.returnTo) : null;
    if (matches) await TokenStorage.clearPendingExternalConnect();
    assertCurrent();
    return { kind: 'connected', machineId, returnTo: normalizeInternalReturnPath(account.returnTo) ?? retainedReturn
        ?? `/settings/mcp/${encodeURIComponent(settled.account.accountId)}` };
}

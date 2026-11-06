import { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1, parseOauthAuthorizationResponse } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import type { ConnectedAccountAttemptResponse } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { runConnectedAccountAuthenticationAction } from './connectedAccountDaemon';

export const CONNECTED_ACCOUNT_OAUTH_OPENER_MESSAGE_TYPE = 'happier.connected-account.oauth';

type ConnectedAccountRef = Extract<ConnectedAccountAttemptResponse, { status: 'connected' }>['account'];
export type ConnectedAccountOAuthCallbackProtocol = Readonly<{
    callbackUrl: string;
    openerMessageType: string;
    service?: ConnectedAccountRef['service'];
    pendingProviderPrefix?: string;
    relayDenial?: boolean;
    connectedReturnPath(account: ConnectedAccountRef): string;
}>;

export const CONNECTED_ACCOUNT_OAUTH_CALLBACK_PROTOCOL: ConnectedAccountOAuthCallbackProtocol = {
    callbackUrl: CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1,
    openerMessageType: CONNECTED_ACCOUNT_OAUTH_OPENER_MESSAGE_TYPE,
    relayDenial: true,
    connectedReturnPath: () => '/settings/connected-services',
};

export type ConnectedAccountOAuthCallbackInput = Readonly<{
    callbackUrl: string;
    browser?: Readonly<{
        /** Clear the visible address synchronously, including when opened by a native universal link. */
        replaceUrl(path: string): void;
        close(): void;
        opener?: Readonly<{ origin?: string; postMessage(message: unknown, origin: string): void }>;
    }>;
    account?: Readonly<{
        serverId: string;
        expectedAccountId: string;
        assertCurrent(): void;
        executeAction?: Parameters<typeof runConnectedAccountAuthenticationAction>[0]['executeAction'];
        returnTo?: string;
        signal?: AbortSignal;
    }>;
}>;

export type ConnectedAccountOAuthCallbackOutcome =
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'opener' }>
    | Readonly<{ kind: 'paste'; callbackUrl: string }>
    | Readonly<{ kind: 'connected'; returnTo: string }>
    | Readonly<{ kind: 'unfinished'; callbackUrl: string; response: ConnectedAccountAttemptResponse }>;

export type ConnectedAccountOAuthCallbackController = Readonly<{
    complete(account?: ConnectedAccountOAuthCallbackInput['account']): Promise<ConnectedAccountOAuthCallbackOutcome>;
}>;

/** Capture and strip synchronously, even when the signed-in Action binding is not ready yet. */
export function createConnectedAccountOAuthCallbackController(
    input: Omit<ConnectedAccountOAuthCallbackInput, 'account'>,
    protocol = CONNECTED_ACCOUNT_OAUTH_CALLBACK_PROTOCOL,
): ConnectedAccountOAuthCallbackController {
    input.browser?.replaceUrl(new URL(protocol.callbackUrl).pathname);
    const response = parseOauthAuthorizationResponse({ input: input.callbackUrl, redirectUri: protocol.callbackUrl });
    return {
        complete: (account?: ConnectedAccountOAuthCallbackInput['account']) => completeCapturedCallback(input, protocol, response, account),
    };
}

export function completeConnectedAccountOAuthCallback(input: ConnectedAccountOAuthCallbackInput,
    protocol = CONNECTED_ACCOUNT_OAUTH_CALLBACK_PROTOCOL): Promise<ConnectedAccountOAuthCallbackOutcome> {
    return createConnectedAccountOAuthCallbackController(input, protocol).complete(input.account);
}

async function completeCapturedCallback(
    input: Omit<ConnectedAccountOAuthCallbackInput, 'account'>,
    protocol: ConnectedAccountOAuthCallbackProtocol,
    response: ReturnType<typeof parseOauthAuthorizationResponse>,
    account: ConnectedAccountOAuthCallbackInput['account'],
): Promise<ConnectedAccountOAuthCallbackOutcome> {
    if (response.kind !== 'callback' || !response.state || (!response.code && !response.error)
        || (response.code && response.error) || (response.error && !protocol.relayDenial)) return { kind: 'invalid' };
    // Only a routing hint. The attempt owner validates the complete nonce, issuer, PKCE and authority.
    const separator = response.state.lastIndexOf('.');
    if (separator <= 0 || separator === response.state.length - 1) return { kind: 'invalid' };
    const attemptId = response.state.slice(0, separator);
    const paste = { kind: 'paste' as const, callbackUrl: input.callbackUrl };
    const origin = new URL(protocol.callbackUrl).origin;
    if (input.browser?.opener) {
        if (input.browser.opener.origin !== origin) return paste;
        input.browser.opener.postMessage({ type: protocol.openerMessageType,
            ...(response.code ? { code: response.code } : {}), state: response.state,
            ...(response.iss === undefined ? {} : { iss: response.iss }),
            ...(response.error ? { error: response.error } : {}) }, origin);
        input.browser.close();
        return { kind: 'opener' };
    }
    // The completion Action accepts a code, not a denial. Never cancel a guessed attempt from its state prefix.
    if (!response.code || response.error || !account) return paste;
    const assertCurrent = () => { account.signal?.throwIfAborted(); account.assertCurrent(); };
    assertCurrent();
    const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
    assertCurrent();
    const target = { serverId: account.serverId, expectedAccountId: account.expectedAccountId,
        assertCurrent, executeAction: account.executeAction, signal: account.signal };
    const restored = await runConnectedAccountAuthenticationAction({ ...target, command: { operation: 'read', attemptId } });
    assertCurrent();
    // The callback may belong to an attempt on another signed-in client; retain its answer for Paste.
    if (restored.status === 'unavailable' && restored.code === 'connected_account_attempt_not_found') return paste;
    const settled = restored.attemptId === attemptId && restored.status === 'awaitingOAuth' && restored.callbackUrl === protocol.callbackUrl
        ? await runConnectedAccountAuthenticationAction({ ...target, command: { operation: 'completeOAuth', attemptId,
            completion: { code: response.code, state: response.state, callbackUrl: protocol.callbackUrl,
                ...(response.iss === undefined ? {} : { iss: response.iss }) } } })
        : restored;
    assertCurrent();
    if (settled.status !== 'connected' || settled.attemptId !== attemptId || (protocol.service
        && (settled.account.service.pluginId !== protocol.service.pluginId || settled.account.service.localId !== protocol.service.localId))) {
        return { kind: 'unfinished', callbackUrl: input.callbackUrl, response: settled };
    }
    const { normalizeInternalReturnPath } = await import('@/utils/path/routeUtils');
    assertCurrent();
    let retainedReturn: string | null = null;
    if (protocol.pendingProviderPrefix) {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        assertCurrent();
        const pending = await TokenStorage.getPendingExternalConnect();
        assertCurrent();
        if (pending?.provider === `${protocol.pendingProviderPrefix}${attemptId}` && pending.serverId === account.serverId) {
            retainedReturn = normalizeInternalReturnPath(pending.returnTo);
            await TokenStorage.clearPendingExternalConnect();
            assertCurrent();
        }
    }
    return { kind: 'connected', returnTo: normalizeInternalReturnPath(account.returnTo) ?? retainedReturn
        ?? protocol.connectedReturnPath(settled.account) };
}

import { parseOauthAuthorizationResponse, type OauthAuthorizationDenial } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { ConnectedAccountAttemptResponseSchema, ConnectedAccountOAuthDenialDiagnosticSchema,
    type ConnectedAccountAttemptResponse } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { runConnectedAccountAuthenticationAction } from './connectedAccountDaemon';
import { resolveConnectedAccountOAuthCallbackPageUrl } from './connectedAccountOAuthCallbackUrl';

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
    callbackUrl: resolveConnectedAccountOAuthCallbackPageUrl(),
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
    | Readonly<{ kind: 'denied'; denial: OauthAuthorizationDenial; providerName?: string;
        retry?: () => Promise<ConnectedAccountAttemptResponse> }>
    | Readonly<{ kind: 'opener' }>
    /** `answer`: what the person carries to the sign-in that started this, shown and copied as is. */
    | Readonly<{ kind: 'paste'; answer: string }>
    | Readonly<{ kind: 'connected'; returnTo: string }>
    | Readonly<{ kind: 'unfinished'; answer: string; response: ConnectedAccountAttemptResponse }>;

export type ConnectedAccountOAuthCallbackController = Readonly<{
    complete(account?: ConnectedAccountOAuthCallbackInput['account']): Promise<ConnectedAccountOAuthCallbackOutcome>;
}>;

type Rejection = Extract<ConnectedAccountAttemptResponse, { status: 'rejected' }>;
type AccountAddress = Pick<NonNullable<ConnectedAccountOAuthCallbackInput['account']>, 'serverId' | 'expectedAccountId'>;
const denialListeners = new Map<string, Set<(response: Rejection) => void>>();

function denialAddress(account: AccountAddress, state: string): string {
    return JSON.stringify(['happier.connected-account.oauth-denial', account.serverId, account.expectedAccountId, state]);
}

function openDenialChannel(address: string): BroadcastChannel | undefined {
    if (typeof window === 'undefined' || typeof BroadcastChannel !== 'function') return;
    try { return new BroadcastChannel(address); } catch { return; }
    return undefined;
}

/** Observe the settled result for the exact state minted for this mounted sheet. */
export function subscribeToConnectedAccountOAuthDenial(account: AccountAddress, authorizationUrl: string,
    listener: (response: Rejection) => void): (() => void) | undefined {
    let state: string | null;
    try { state = new URL(authorizationUrl).searchParams.get('state'); } catch { return; }
    if (!state) return;
    const address = denialAddress(account, state);
    const channel = openDenialChannel(address);
    if (channel) {
        channel.onmessage = event => {
            const parsed = ConnectedAccountAttemptResponseSchema.safeParse(event.data);
            if (parsed.success && parsed.data.status === 'rejected' && parsed.data.code === 'connected_account_oauth_denied') {
                listener(parsed.data);
            }
        };
        return () => channel.close();
    }
    const listeners = denialListeners.get(address) ?? new Set();
    listeners.add(listener);
    denialListeners.set(address, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) denialListeners.delete(address);
    };
}

async function settleDenial(account: ConnectedAccountOAuthCallbackInput['account'], attemptId: string,
    completion: Readonly<{ state: string; iss?: string; callbackUrl: string; denial: OauthAuthorizationDenial }>,
): Promise<ConnectedAccountOAuthCallbackOutcome> {
    const fallback = { kind: 'denied' as const, denial: completion.denial };
    if (!account) return fallback;
    try {
        const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
        const { requestId: _requestId, ...settled } = await runConnectedAccountAuthenticationAction({
            ...account, command: { operation: 'completeOAuth', attemptId, completion },
        });
        if (settled.status !== 'rejected' || settled.attemptId !== attemptId) return fallback;
        if (settled.code === 'connected_account_oauth_completion_invalid' || settled.code === 'connected_account_oauth_issuer_invalid') {
            return { kind: 'invalid' };
        }
        if (settled.code !== 'connected_account_oauth_denied') return fallback;
        const diagnostic = ConnectedAccountOAuthDenialDiagnosticSchema.safeParse(settled.diagnostic);
        if (!diagnostic.success) return fallback;
        const address = denialAddress(account, completion.state);
        // Send only the attempt result. The state stays in the private per-attempt address.
        const channel = openDenialChannel(address);
        if (channel) {
            try { channel.postMessage(settled); } finally { channel.close(); }
        } else {
            for (const listener of denialListeners.get(address) ?? []) listener(settled);
        }
        const { denial, providerName, retry, machineId } = diagnostic.data;
        return { kind: 'denied', denial, providerName,
            retry: () => runConnectedAccountAuthenticationAction({ ...account, machineId, command: retry }),
        };
    } catch {
        // A public callback can arrive on a browser without access to the attempt.
        return fallback;
    }
}

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

/**
 * The answer as the Connect sheet's paste field reads it: the shared parser's `code#state` when that holds
 * the whole answer (it reads back to the same code and state, and there is no issuer to carry), otherwise
 * the complete callback.
 */
function readPasteableAnswer(callbackUrl: string, response: ReturnType<typeof parseOauthAuthorizationResponse>): string {
    if (response.kind !== 'callback' || !response.code || !response.state || response.error || response.iss !== undefined) return callbackUrl;
    const compact = `${response.code}#${response.state}`;
    const reread = parseOauthAuthorizationResponse({ input: compact });
    return reread.kind === 'codeState' && reread.code === response.code && reread.state === response.state ? compact : callbackUrl;
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
    if (response.error) {
        const { error, errorDescription, errorUri } = response;
        return settleDenial(account, attemptId, { state: response.state, callbackUrl: protocol.callbackUrl,
            ...(response.iss === undefined ? {} : { iss: response.iss }), denial: { error,
            ...(errorDescription === undefined ? {} : { errorDescription }),
            ...(errorUri === undefined ? {} : { errorUri }),
            },
        });
    }
    const answer = readPasteableAnswer(input.callbackUrl, response);
    const paste = { kind: 'paste' as const, answer };
    const origin = new URL(protocol.callbackUrl).origin;
    if (input.browser?.opener) {
        if (input.browser.opener.origin !== origin) return paste;
        input.browser.opener.postMessage({ type: protocol.openerMessageType,
            ...(response.code ? { code: response.code } : {}), state: response.state,
            ...(response.iss === undefined ? {} : { iss: response.iss }) }, origin);
        input.browser.close();
        return { kind: 'opener' };
    }
    if (!response.code || !account) return paste;
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
        return { kind: 'unfinished', answer, response: settled };
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

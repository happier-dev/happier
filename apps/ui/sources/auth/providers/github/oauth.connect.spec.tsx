import { ExternalOAuthFinalizeConnectSuccessResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { getCurrentAuth } from '@/auth/context/AuthContext';
import { createDeferred } from '@/dev/testkit';
import { t } from '@/text';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setOAuthRuntimeFetch as setRuntimeFetch } from '@/auth/providers/github/test/oauthReturnHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    clearPendingExternalConnectMock,
    flushOAuthEffects,
    localSearchParamsMock,
    modal,
    oauthDefaultHome,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setAuthState,
    setPendingExternalConnectState,
    setStoredCredentialsState,
} from './test/oauthReturnHarness';

type FetchResult = {
    ok: boolean;
    status?: number;
    body: unknown;
};

const OAUTH_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

function setAuthenticated() {
    setAuthState({
        isAuthenticated: true,
        credentials: { token: createAccountTokenForTests('t'), secret: OAUTH_SECRET },
    });
}

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<FetchResult>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/health')) {
            return Response.json({ ok: true });
        }
        if (url.endsWith('/v1/auth/ping')) {
            return Response.json({ ok: true });
        }
        const result = await handler(url, init);
        return Response.json(result.body, { status: result.status ?? (result.ok ? 200 : 500) });
    });
    vi.stubGlobal('fetch', fetchMock);
    setRuntimeFetch(fetchMock);
    return fetchMock;
}



afterEach(() => {
    resetOAuthHarness();
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('/oauth/[provider] (connect flow)', () => {
    it('clears failed connect custody and returns to its saved destination', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        clearPendingExternalConnectMock.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: 'oauth_not_configured',
        });

        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(clearPendingExternalConnectMock).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

    });

    it('shows a friendly message for oauth_not_configured', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: 'oauth_not_configured',
        });

        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalledWith(
                t('common.error'),
                t('friends.providerGate.notConfigured', { provider: 'GitHub' }),
            );
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

    });

    it('never presents an untrusted provider callback error verbatim', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: '<script>provider detail</script>',
        });
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalledWith(t('common.error'), t('errors.operationFailed'));
            expect(JSON.stringify(alertSpy.mock.calls)).not.toContain('provider detail');
        });

    });

    it('cancels pending connect when user closes the username prompt', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.includes('/v1/connect/external/github/pending/')) {
                expect(init?.method).toBe('DELETE');
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = modal.prompt.mockResolvedValue(null);
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/pending/'), expect.anything());
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });


    });

    it('navigates away even if cancel pending throws', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        stubFetch(async () => {
            throw Object.assign(new Error('Network request aborted'), { name: 'AbortError' });
        });

        const promptSpy = modal.prompt.mockResolvedValue(null);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

    });

    it('finalizes normal connect and adopts the replacement credential', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-normal',
            username: 'account-owner',
        });
        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    pending: 'p-normal',
                    username: 'account-owner',
                });
                return { ok: true, body: ExternalOAuthFinalizeConnectSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('t', { currentAccount: true }) }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(await TokenStorage.getCredentials()).toEqual({
                token: createAccountTokenForTests('t', { currentAccount: true }), secret: OAUTH_SECRET,
            });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('preserves predecessor callback completion without a pending finalizer handle', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('t'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('clears normal connect continuation after a typed finalization error', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-normal',
            username: 'account-owner',
        });
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'invalid-pending' },
        }));
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('finalizes connect when the user picks an available username', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}'));
                expect(body).toEqual({ pending: 'p1', username: 'octocat_2' });
                return { ok: true, body: ExternalOAuthFinalizeConnectSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('t', { currentAccount: true }) }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = modal.prompt.mockResolvedValue('octocat_2');
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/finalize'), expect.anything());
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('t', { currentAccount: true }), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });


    });

    it('keeps predecessor connect completion usable when no replacement credential is returned', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });
        stubFetch(async (url) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const promptSpy = modal.prompt.mockResolvedValue('octocat_2');

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('t'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

    });

    it('re-prompts when the chosen username is taken', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                const callCount = fetchMock.mock.calls.filter((call) =>
                    String(call[0]).endsWith('/v1/connect/external/github/finalize'),
                ).length;
                if (callCount === 1) {
                    return {
                        ok: false,
                        status: 409,
                        body: { error: 'username-taken' },
                    };
                }
                return { ok: true, body: ExternalOAuthFinalizeConnectSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('t', { currentAccount: true }) }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = modal.prompt
            .mockResolvedValueOnce('octocat')
            .mockResolvedValueOnce('octocat_2');
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(10);
            expect(promptSpy).toHaveBeenCalledTimes(2);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
            expect(alertSpy).not.toHaveBeenCalled();
        });


    });
    it('finalizes a Team connect on the exact Home that started it while another Home stays focused', async () => {
        // Home A is focused (its credential is the in-memory auth state); the Team
        // connect was started with the saved credential of Home B (TA-R14/TA-R16).
        setAuthenticated();
        replaceSpy.mockReset();
        setStoredCredentialsState({ token: createAccountTokenForTests('home-b-token') }, { serverId: 'srv_server-b', serverUrl: 'https://home-b.example.test' });
        setPendingExternalConnectState({
            provider: 'github',
            returnTo: '/teams/team-1/sign-in?target=home-b',
            serverId: 'srv_server-b',
            serverUrl: 'https://home-b.example.test',
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-team',
            username: 'member',
        });
        const fetchMock = stubFetch(async (url, init) => {
            if (url === 'https://home-b.example.test/v1/connect/external/github/finalize') {
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${createAccountTokenForTests('home-b-token')}`);
                return { ok: true, body: ExternalOAuthFinalizeConnectSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('home-b-token', { currentAccount: true }) }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                'https://home-b.example.test/v1/connect/external/github/finalize',
                expect.anything(),
            );
            // The replacement is persisted for Home B without focusing it or touching A.
            await vi.waitFor(async () => {
                expect(await TokenStorage.getCredentialsForServerUrl('https://home-b.example.test', { serverId: 'srv_server-b' }))
                    .toEqual({ token: createAccountTokenForTests('home-b-token', { currentAccount: true }) });
            });
            expect(getActiveServerSnapshot().serverUrl).toBe('http://default.example.test');
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('t'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=home-b');
        });
    });

    it.each(['different-account', 'signed-out'] as const)('retires the original connect when the credential becomes %s', async (next) => {
        setAuthenticated();
        setPendingExternalConnectState({ ...oauthDefaultHome, provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github', flow: 'connect', status: 'connected', pending: 'original-pending', username: 'octocat',
        });
        const originalResponse = createDeferred<FetchResult>();
        let originalSignal: AbortSignal | null | undefined;
        let finalizations = 0;
        stubFetch(async (url, init) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                finalizations += 1;
                if (finalizations === 1) {
                    originalSignal = init?.signal;
                    return await originalResponse.promise;
                }
                return { ok: false, status: 403, body: { error: 'invalid-state' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const nextCredentials = { token: createAccountTokenForTests('other-account') };
        try {
            await runWithOAuthScreen(async () => {
                await vi.waitFor(() => expect(originalSignal).toBeTruthy());
                const auth = getCurrentAuth();
                if (!auth) throw new Error('Expected the real mounted Auth provider');
                await act(async () => {
                    if (next === 'signed-out') await auth.logout();
                    else await auth.loginWithCredentials(nextCredentials);
                });
                expect(originalSignal?.aborted).toBe(true);
                originalResponse.resolve({ ok: true, body: ExternalOAuthFinalizeConnectSuccessResponseSchema.parse({
                    success: true, token: createAccountTokenForTests('t', { currentAccount: true }),
                }) });
                await flushOAuthEffects();
                expect(await TokenStorage.getCredentials()).toEqual(next === 'signed-out' ? null : nextCredentials);
            });
        } finally {
            originalResponse.resolve({ ok: false, status: 403, body: { error: 'invalid-state' } });
        }
    });

    it('presents a typed Team refusal from the exact Home instead of a generic failure', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setStoredCredentialsState({ token: createAccountTokenForTests('home-b-token') }, { serverId: 'srv_server-b', serverUrl: 'https://home-b.example.test' });
        setPendingExternalConnectState({
            provider: 'github',
            returnTo: '/teams/team-1/sign-in?target=home-b',
            serverId: 'srv_server-b',
            serverUrl: 'https://home-b.example.test',
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-team',
            username: 'member',
        });
        stubFetch(async (url) => {
            if (url === 'https://home-b.example.test/v1/connect/external/github/finalize') {
                return { ok: false, status: 403, body: { error: 'team_authentication_required' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const alertSpy = modal.alert.mockImplementation(async () => {});

        await runWithOAuthScreen(async (screen) => {
            await flushOAuthEffects();
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('t'), secret: OAUTH_SECRET });
            expect(alertSpy).not.toHaveBeenCalled();
            expect(JSON.stringify(screen.toJSON())).toContain(t('teams.entry.notProvisionedTitle'));
        });

    });
});

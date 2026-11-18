import { ExternalOAuthFinalizeAuthSuccessResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    flushOAuthEffects,
    localSearchParamsMock,
    modal,
    replaceSpy,
    resetOAuthHarness,
    clearPendingExternalAuthMock,
    runWithOAuthScreen,
    setPendingExternalAuthState,
    oauthDefaultHome,
    setStoredCredentialsState,
    setActiveServerSnapshot,
    trackAccountCreatedSpy,
    accountDirectoryExchangeOAuthSpy,
    pendingAccountDirectoryAuthClearSpy,
    setPendingAccountDirectoryAuthState,
} from './test/oauthReturnHarness';
import { createDeferred, findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { setRuntimeFetch as setRawRuntimeFetch } from '@/utils/system/runtimeFetch';
import { oauthNativeStorageBoundary } from './test/oauthReturnHarness';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setOAuthRuntimeFetch as setRuntimeFetch, OAuthHarnessProvider, prepareOAuthHarness } from '@/auth/providers/github/test/oauthReturnHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';


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

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<FetchResult>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const result = await handler(String(input), init);
        return Response.json(result.body, { status: result.status ?? (result.ok ? 200 : 500) });
    });
    vi.stubGlobal('fetch', fetchMock);
    setRuntimeFetch(fetchMock);
    return fetchMock;
}

async function handleHealthCheck(url: string): Promise<FetchResult | null> {
    if (!url.endsWith('/health')) return null;
    return { ok: true, body: { ok: true } };
}

afterEach(() => {
    resetOAuthHarness();
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('/oauth/[provider] (auth flow)', () => {
    it('removes Account Service Cancel at credential commit and completes the recorded continuation', async () => {
        resetOAuthHarness();
        const endpoint = 'https://directory.test';
        const serverIdentityId = 'srv_directory';
        const pending = {
            endpoint,
            serverIdentityId,
            canonicalServerUrl: endpoint,
            provider: 'github',
            purpose: 'account_directory' as const,
            credentialTarget: 'account_directory' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } },
            mode: 'keyless' as const,
            proof: 'bound-proof',
            pending: 'provider-pending',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            returnTo: '/setup/wizard',
        };
        setPendingAccountDirectoryAuthState(pending);
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            purpose: 'account_directory',
            credentialTarget: 'account_directory',
            endpointUrl: endpoint,
            serverIdentityId,
            canonicalServerUrl: endpoint,
            pending: pending.pending,
            mode: pending.mode,
        });
        const fixture = createDirectoryHttpFixture();
        const releaseFinalizer = createDeferred<void>();
        const credentialWriteStarted = createDeferred<void>();
        const releaseCredentialWrite = createDeferred<void>();
        oauthNativeStorageBoundary.beforeWrite = async (_key, value) => {
            if (value.includes(fixture.directoryToken)) {
                credentialWriteStarted.resolve();
                await releaseCredentialWrite.promise;
            }
        };
        setRawRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname.endsWith('/finalize-keyless')) await releaseFinalizer.promise;
            const bootstrap = createEmptyAccountBootstrapHttpResponse(url.pathname + url.search, init);
            return bootstrap ?? fixture.request(url.origin, url.pathname + url.search, init);
        });

        await prepareOAuthHarness();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
        const screen = await renderScreen(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }));
        try {
            await vi.waitFor(() => expect(accountDirectoryExchangeOAuthSpy).toHaveBeenCalledOnce());
            const findCancel = () => findTestInstanceByTypeContainingText(screen, 'Pressable', t('common.cancel'));
            await vi.waitFor(() => expect(findCancel()).toBeTruthy());
            const cancelButton = findCancel();
            expect(cancelButton?.props.onPress).toBeTypeOf('function');
            expect(screen.getTextContent()).toContain('Signing in');
            const lateCancel = cancelButton!.props.onPress as () => Promise<void>;

            await act(async () => {
                releaseFinalizer.resolve();
                await credentialWriteStarted.promise;
            });
            await vi.waitFor(() => expect(findCancel()).toBeUndefined());
            expect(findCancel()).toBeUndefined();
            await lateCancel();
            expect(pendingAccountDirectoryAuthClearSpy).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();

            await act(async () => {
                releaseCredentialWrite.resolve();
                await accountDirectoryExchangeOAuthSpy.mock.results[0]?.value;
            });
            await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(expect.objectContaining({
                pathname: '/setup/wizard',
                params: expect.objectContaining({ accountServiceReturn: '1' }),
            })));
            expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint, serverIdentityId }))
                .toEqual({ token: fixture.directoryToken });
        } finally {
            releaseFinalizer.resolve();
            releaseCredentialWrite.resolve();
            await screen.unmount();
        }
    });

    it('uses the pending external auth serverUrl for finalize requests when present', async () => {
        setActiveServerSnapshot({ serverId: 'srv_api', serverUrl: 'http://api.example.test' });
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET, serverUrl: 'http://api.example.test' });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const urlString = String(url);
            const health = await handleHealthCheck(urlString);
            if (health) {
                return new Response(JSON.stringify(health.body), {
                    status: health.status ?? 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (urlString === 'http://api.example.test/v1/auth/external/github/finalize') {
                expect(init?.method).toBe('POST');
                return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') })), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected fetch: ${urlString}`);
        });
        setRuntimeFetch(fetchMock);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(await TokenStorage.getCredentialsForServerUrl('http://api.example.test')).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('falls back to resolving the provider id from window.location.pathname', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            flow: 'auth',
            pending: 'p1',
        });

        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        vi.stubGlobal('window', {
            location: {
                pathname: '/oauth/github',
            },
        });

        const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const urlString = String(url);
            const health = await handleHealthCheck(urlString);
            if (health) {
                return new Response(JSON.stringify(health.body), {
                    status: health.status ?? 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (urlString.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') })), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected fetch: ${urlString}`);
        });
        setRuntimeFetch(fetchMock);

        try {
            await runWithOAuthScreen(async () => {
                await flushOAuthEffects();
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/v1/auth/external/github/finalize'),
                    expect.anything(),
                );
                expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
                expect(replaceSpy).toHaveBeenCalledWith('/');
            });
        } finally {
            if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
            else Reflect.deleteProperty(globalThis, 'window');
        }
    });

    it('falls back to resolving query params from window.location.search on cold start', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        // Some web cold-starts/hydration paths can temporarily omit search params from useLocalSearchParams.
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
        });

        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        vi.stubGlobal('window', {
            location: {
                pathname: '/oauth/github',
                search: '?flow=auth&pending=p1',
            },
        });

        const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const urlString = String(url);
            const health = await handleHealthCheck(urlString);
            if (health) {
                return new Response(JSON.stringify(health.body), {
                    status: health.status ?? 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (urlString.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.pending).toBe('p1');
                return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') })), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected fetch: ${urlString}`);
        });
        setRuntimeFetch(fetchMock);

        try {
            await runWithOAuthScreen(async () => {
                await flushOAuthEffects();
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/v1/auth/external/github/finalize'),
                    expect.anything(),
                );
                expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
                expect(replaceSpy).toHaveBeenCalledWith('/');
            });
        } finally {
            if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
            else Reflect.deleteProperty(globalThis, 'window');
        }
    });

    it('finalizes external auth and logs in when flow=auth', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.pending).toBe('p1');
                expect(typeof body.publicKey).toBe('string');
                expect(typeof body.challenge).toBe('string');
                expect(typeof body.signature).toBe('string');
                return { ok: true, body: ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/auth/external/github/finalize'),
                expect.anything(),
            );
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
            expect(trackAccountCreatedSpy).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('does not show an initialization error when pending state is missing but credentials already exist', async () => {
        setPendingExternalAuthState(null);
        setStoredCredentialsState({ token: createAccountTokenForTests('existing-account'), secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        stubFetch(async (url) => {
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('existing-account'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('renders a username form and includes it in finalize when status=username_required', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            status: 'username_required',
            reason: 'login_taken',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.username).toBe('octocat_2');
                return { ok: true, body: ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await prepareOAuthHarness();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
        const screen = await renderScreen(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }));
        try {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalledWith(
                expect.stringContaining('/v1/auth/external/github/finalize'),
                expect.anything(),
            );

            const input = screen.findByTestId('oauth-username-input');
            expect(input).toBeTruthy();
            act(() => {
                input?.props.onChangeText('octocat_2');
            });

            await screen.pressByTestIdAsync('oauth-username-save');
            await flushOAuthEffects();

            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/');
        } finally {
            await screen.unmount();
        }
    });

    it('redirects to the pending external auth returnTo after login when provided', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET, returnTo: '/settings/account' });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        stubFetch(async (url) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return { ok: true, body: ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });
    });

    it('includes reset=true in finalize when pending external auth intent=reset', async () => {
        setActiveServerSnapshot({ serverId: 'srv_api', serverUrl: 'http://api.example.test' });
        setPendingExternalAuthState({
            provider: 'github',
            secret: OAUTH_SECRET,
            intent: 'reset',
            serverUrl: 'http://api.example.test',
        });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.reset).toBe(true);
                return { ok: true, body: ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/auth/external/github/finalize'),
                expect.anything(),
            );
            expect((await import('@/sync/domains/server/serverRuntime')).getActiveServerSnapshot().serverUrl).toBe('http://api.example.test');
            expect(await TokenStorage.getCredentialsForServerUrl('http://api.example.test')).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
        });
    });

    it('logs in and redirects even if the effect is cancelled by a params re-render (success token)', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();
        clearPendingExternalAuthMock.mockClear();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        let resolveFinalize: ((result: FetchResult) => void) | null = null;
        const finalizeDeferred = new Promise<FetchResult>((resolve) => {
            resolveFinalize = resolve;
        });

        const fetchMock = stubFetch(async (url) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return await finalizeDeferred;
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await prepareOAuthHarness();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }))).tree;
        if (!tree) throw new Error('Expected OAuth screen to render');
        const ensuredTree = tree;
        try {
            await flushOAuthEffects();

            // Simulate expo-router updating params after hydration; this cancels the first effect run.
            localSearchParamsMock.mockReturnValue({
                provider: 'github',
                flow: 'auth',
                pending: 'p1',
                hydrated: '1',
            });
            act(() => {
                ensuredTree.update(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }));
            });

            await act(async () => {
                resolveFinalize?.({ ok: true, status: 200, body: ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') }) });
            });
            await flushOAuthEffects();

            await vi.waitFor(async () => {
                expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_1'), secret: OAUTH_SECRET });
                expect(replaceSpy).toHaveBeenCalledWith('/');
            });
        } finally {
            act(() => {
                ensuredTree.unmount();
            });
        }
    });

    it('redirects to restore even if the effect is cancelled by a params re-render (provider already linked)', async () => {
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        modal.alert.mockClear();
        modal.prompt.mockReset();
        clearPendingExternalAuthMock.mockClear();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        let resolveFinalize: ((result: FetchResult) => void) | null = null;
        const finalizeDeferred = new Promise<FetchResult>((resolve) => {
            resolveFinalize = resolve;
        });

        const fetchMock = stubFetch(async (url) => {
            const health = await handleHealthCheck(url);
            if (health) return health;
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return await finalizeDeferred;
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await prepareOAuthHarness();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }))).tree;
        if (!tree) throw new Error('Expected OAuth screen to render');
        const ensuredTree = tree;
        try {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/external/github/finalize'), expect.anything());

            // Simulate expo-router updating params after hydration; this cancels the first effect run
            // (cleanup sets cancelled=true) and previously could suppress navigation.
            localSearchParamsMock.mockReturnValue({
                provider: 'github',
                flow: 'auth',
                pending: 'p1',
                hydrated: '1',
            });
            act(() => {
                ensuredTree.update(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }));
            });

            await act(async () => {
                resolveFinalize?.({ ok: false, status: 409, body: { error: 'provider-already-linked', provider: 'github' } });
            });
            await flushOAuthEffects();

            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/restore?provider=github&reason=provider_already_linked');
            expect(modal.alert).not.toHaveBeenCalled();
            expect(await TokenStorage.getCredentials()).toBeNull();
        } finally {
            act(() => {
                ensuredTree.unmount();
            });
        }
    });
});

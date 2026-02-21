import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    flushOAuthEffects,
    localSearchParamsMock,
    loginSpy,
    modal,
    replaceSpy,
    resetOAuthHarness,
    clearPendingExternalAuthMock,
    runWithOAuthScreen,
    setPendingExternalAuthState,
    setActiveServerSnapshot,
    upsertAndActivateServerSpy,
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

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<FetchResult>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const result = await handler(String(input), init);
        return {
            ok: result.ok,
            status: result.status ?? (result.ok ? 200 : 500),
            json: async () => result.body,
        } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => {
    resetOAuthHarness();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('/oauth/[provider] (auth flow)', () => {
    it('uses the pending external auth serverUrl for finalize requests when present', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET, serverUrl: 'http://api.example.test' });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url === 'http://api.example.test/v1/auth/external/github/finalize') {
                expect(init?.method).toBe('POST');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('falls back to resolving the provider id from window.location.pathname', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            flow: 'auth',
            pending: 'p1',
        });

        const originalWindow = (globalThis as any).window;
        (globalThis as any).window = {
            location: {
                pathname: '/oauth/github',
            },
        };

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        try {
            await runWithOAuthScreen(async () => {
                await flushOAuthEffects();
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/v1/auth/external/github/finalize'),
                    expect.anything(),
                );
                expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
                expect(replaceSpy).toHaveBeenCalledWith('/');
            });
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });

    it('falls back to resolving query params from window.location.search on cold start', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        // Some web cold-starts/hydration paths can temporarily omit search params from useLocalSearchParams.
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
        });

        const originalWindow = (globalThis as any).window;
        (globalThis as any).window = {
            location: {
                pathname: '/oauth/github',
                search: '?flow=auth&pending=p1',
            },
        };

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.pending).toBe('p1');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        try {
            await runWithOAuthScreen(async () => {
                await flushOAuthEffects();
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/v1/auth/external/github/finalize'),
                    expect.anything(),
                );
                expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
                expect(replaceSpy).toHaveBeenCalledWith('/');
            });
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });

    it('finalizes external auth and logs in when flow=auth', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.pending).toBe('p1');
                expect(typeof body.publicKey).toBe('string');
                expect(typeof body.challenge).toBe('string');
                expect(typeof body.signature).toBe('string');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/auth/external/github/finalize'),
                expect.anything(),
            );
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('renders a username form and includes it in finalize when status=username_required', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
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
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.username).toBe('octocat_2');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async (tree) => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();

            const input = tree.root.findByProps({ testID: 'oauth-username-input' });
            act(() => {
                input.props.onChangeText('octocat_2');
            });

            const save = tree.root.findByProps({ testID: 'oauth-username-save' });
            await act(async () => {
                await save.props.onPress();
            });
            await flushOAuthEffects();

            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('redirects to the pending external auth returnTo after login when provided', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET, returnTo: '/settings/account' });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        stubFetch(async (url) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });
    });

    it('includes reset=true in finalize when pending external auth intent=reset', async () => {
        setActiveServerSnapshot({ serverUrl: 'http://default.example.test' });
        setPendingExternalAuthState({
            provider: 'github',
            secret: OAUTH_SECRET,
            intent: 'reset',
            serverUrl: 'http://api.example.test',
        });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        upsertAndActivateServerSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.reset).toBe(true);
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/auth/external/github/finalize'),
                expect.anything(),
            );
            expect(upsertAndActivateServerSpy).toHaveBeenCalledWith(
                expect.objectContaining({ serverUrl: 'http://api.example.test' }),
            );
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
        });
    });

    it('logs in and redirects even if the effect is cancelled by a params re-render (success token)', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
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
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return await finalizeDeferred;
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        if (!tree) throw new Error('Expected OAuth screen to render');
        const ensuredTree = tree;
        try {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/external/github/finalize'), expect.anything());

            // Simulate expo-router updating params after hydration; this cancels the first effect run.
            localSearchParamsMock.mockReturnValue({
                provider: 'github',
                flow: 'auth',
                pending: 'p1',
                hydrated: '1',
            });
            act(() => {
                ensuredTree.update(React.createElement(Screen));
            });

            await act(async () => {
                resolveFinalize?.({ ok: true, status: 200, body: { token: 'tok_1' } });
            });
            await flushOAuthEffects();

            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        } finally {
            act(() => {
                ensuredTree.unmount();
            });
        }
    });

    it('redirects to restore even if the effect is cancelled by a params re-render (provider already linked)', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
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
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                return await finalizeDeferred;
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/oauth/[provider]');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
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
                ensuredTree.update(React.createElement(Screen));
            });

            await act(async () => {
                resolveFinalize?.({ ok: false, status: 409, body: { error: 'provider-already-linked', provider: 'github' } });
            });
            await flushOAuthEffects();

            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/restore?provider=github&reason=provider_already_linked');
        } finally {
            act(() => {
                ensuredTree.unmount();
            });
        }
    });
});

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/text';
import {
    clearPendingExternalConnectMock,
    flushOAuthEffects,
    localSearchParamsMock,
    modal,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setAuthState,
    setPendingExternalConnectState,
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
        credentials: { token: 't', secret: OAUTH_SECRET },
    });
}

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

vi.mock('@/utils/timing/time', async () => {
    const actual = await vi.importActual<typeof import('@/utils/timing/time')>('@/utils/timing/time');
    return {
        ...actual,
        backoff: async (callback: () => Promise<unknown>) => await callback(),
    };
});

afterEach(() => {
    resetOAuthHarness();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('/oauth/[provider] (connect flow)', () => {
    it('clears pending connect state when callback contains an oauth error', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        clearPendingExternalConnectMock.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: 'oauth_not_configured',
        });

        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(clearPendingExternalConnectMock).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        alertSpy.mockRestore();
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

        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalledWith(
                t('common.error'),
                t('friends.providerGate.notConfigured', { provider: 'GitHub' }),
            );
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        alertSpy.mockRestore();
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

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue(null);
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/pending/'), expect.anything());
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
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
            throw new Error('network');
        });

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue(null);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        promptSpy.mockRestore();
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
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue('octocat_2');
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/finalize'), expect.anything());
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
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
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = vi
            .spyOn(modal, 'prompt')
            .mockResolvedValueOnce('octocat')
            .mockResolvedValueOnce('octocat_2');
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(10);
            expect(promptSpy).toHaveBeenCalledTimes(2);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
            expect(alertSpy).not.toHaveBeenCalled();
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
    });
});

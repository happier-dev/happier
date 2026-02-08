import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    flushOAuthEffects,
    localSearchParamsMock,
    loginSpy,
    modal,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setPendingExternalAuthState,
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
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('prompts for username and includes it in finalize when status=username_required', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET });
        replaceSpy.mockReset();
        loginSpy.mockClear();
        modal.alert.mockClear();
        modal.prompt.mockReset();
        modal.prompt.mockResolvedValueOnce('octocat_2');

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            status: 'username_required',
            reason: 'login_taken',
            login: 'octocat',
            pending: 'p1',
        });

        stubFetch(async (url, init) => {
            if (url.endsWith('/v1/auth/external/github/finalize')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                expect(body.username).toBe('octocat_2');
                return { ok: true, body: { success: true, token: 'tok_1' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(modal.prompt).toHaveBeenCalled();
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('includes reset=true in finalize when pending external auth intent=reset', async () => {
        setPendingExternalAuthState({ provider: 'github', secret: OAUTH_SECRET, intent: 'reset' });
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
            expect(loginSpy).toHaveBeenCalledWith('tok_1', OAUTH_SECRET);
        });
    });
});

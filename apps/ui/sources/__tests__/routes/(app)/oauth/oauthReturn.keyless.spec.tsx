import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearPendingExternalAuthMock,
    flushOAuthEffects,
    localSearchParamsMock,
    loginWithCredentialsSpy,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setPendingExternalAuthState,
} from '@/auth/providers/github/test/oauthReturnHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
    vi.unstubAllGlobals();
    resetOAuthHarness();
});

describe('oauth/[provider] return (keyless)', () => {
    it('finalizes keyless oauth auth for a plaintext account and logs in with data-key credentials', async () => {
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockReset();
        clearPendingExternalAuthMock.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'plain',
            pending: 'p1',
        });
        setPendingExternalAuthState({ provider: 'github', proof: 'proof_1' });

        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn(async (url: any, init?: any) => {
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                const body = JSON.parse(String(init?.body ?? '{}'));
                if (body?.pending !== 'p1' || body?.proof !== 'proof_1') {
                    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
                }
                return new Response(JSON.stringify({ success: true, token: 'tok_1' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    token: 'tok_1',
                    encryption: expect.objectContaining({
                        publicKey: expect.any(String),
                        machineKey: expect.any(String),
                    }),
                }),
            );
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });

        vi.stubGlobal('fetch', originalFetch);
    });

    it('redirects to /restore for an e2ee account (without attempting keyless finalize)', async () => {
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockReset();
        clearPendingExternalAuthMock.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'e2ee',
            pending: 'p2',
        });
        setPendingExternalAuthState({ provider: 'github', proof: 'proof_2' });

        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/restore');
        });

        vi.stubGlobal('fetch', originalFetch);
    });
});

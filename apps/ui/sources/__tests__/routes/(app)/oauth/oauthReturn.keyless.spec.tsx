import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearPendingExternalAuthMock,
    localSearchParamsMock,
    loginWithCredentialsSpy,
    modal,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setPendingExternalAuthState,
    setPendingExternalAuthServerMismatch,
} from '@/auth/providers/github/test/oauthReturnHarness';
import { t } from '@/text';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

const keylessToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-keyless' })).toString('base64url')}.signature`;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    resetOAuthHarness();
});

describe('oauth/[provider] return (keyless)', () => {
    it('surfaces oauth state mismatch and clears stale pending auth when the pending auth belongs to a different server context', async () => {
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockReset();
        clearPendingExternalAuthMock.mockReset();
        modal.alert.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p-mismatch',
        });
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'proof_mismatch',
            serverId: 'server-a',
            serverUrl: 'https://shared.example.test',
        });
        setPendingExternalAuthServerMismatch(true);

        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.oauthStateMismatch'));
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });

        vi.stubGlobal('fetch', originalFetch);
    });

    it('finalizes keyless oauth auth for a plaintext account and logs in with token-only credentials', async () => {
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
            if (String(url).endsWith('/v1/features')) {
                return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                    features: { encryption: { plaintextMachine: { enabled: true } } },
                })), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (typeof url === 'string' && url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                const body = JSON.parse(String(init?.body ?? '{}'));
                if (body?.pending !== 'p1' || body?.proof !== 'proof_1') {
                    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
                }
                return new Response(JSON.stringify({ success: true, token: keylessToken }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            expect(fetchMock).toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: keylessToken });
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
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/restore');
        });

        vi.stubGlobal('fetch', originalFetch);
    });
});

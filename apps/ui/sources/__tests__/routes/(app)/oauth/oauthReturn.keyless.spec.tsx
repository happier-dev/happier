import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearPendingExternalAuthMock,
    flushOAuthEffects,
    getRandomBytesSpy,
    localSearchParamsMock,
    loginWithCredentialsSpy,
    modal,
    readPendingExternalAuthStateMock,
    replaceSpy,
    resetOAuthHarness,
    resumeAccountEncryptionFirstKeyExternalAuthSpy,
    runWithOAuthScreen,
    setAuthState,
    setPendingExternalAuthState,
    setPendingExternalAuthServerMismatch,
    trackAccountRestoredSpy,
} from '@/auth/providers/github/test/oauthReturnHarness';
import { t } from '@/text';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { HappyError } from '@/utils/errors/errors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    resetOAuthHarness();
});

describe('oauth/[provider] return (keyless)', () => {
    it.each([
        {
            name: 'missing provider',
            params: {
                flow: 'auth',
                purpose: 'account_encryption_first_key',
                pending: 'oauth-pending',
            },
            serverMismatch: false,
        },
        {
            name: 'unknown provider',
            params: {
                provider: 'unknown-provider',
                flow: 'auth',
                purpose: 'account_encryption_first_key',
                pending: 'oauth-pending',
            },
            serverMismatch: false,
        },
        {
            name: 'callback error',
            params: {
                provider: 'github',
                flow: 'auth',
                purpose: 'account_encryption_first_key',
                pending: 'oauth-pending',
                error: 'access_denied',
            },
            serverMismatch: false,
        },
        {
            name: 'missing credentials',
            params: {
                provider: 'github',
                flow: 'auth',
                purpose: 'account_encryption_first_key',
                pending: 'oauth-pending',
            },
            serverMismatch: false,
        },
        {
            name: 'missing purpose on server mismatch',
            params: {
                provider: 'github',
                flow: 'auth',
                pending: 'oauth-pending',
            },
            serverMismatch: true,
        },
    ])(
        'retains marked first-key custody on $name',
        async ({ params, serverMismatch }) => {
            const createdAt = Date.now();
            const marked = {
                provider: 'github',
                proof: 'browser-proof',
                secret: 'proposed-secret',
                accountEncryptionFirstKey: {
                    accountId: 'account-1',
                    requestDigest:
                        `aemrb1_${'A'.repeat(43)}`,
                    requestJson: '{"toMode":"e2ee"}',
                    createdAt,
                    expiresAt:
                        createdAt + 10 * 60 * 1000,
                    pending: 'oauth-pending',
                    migrationSubmissionAttempted: true,
                },
            } as const;
            setAuthState({
                isAuthenticated: false,
                credentials: null,
            });
            setPendingExternalAuthState(marked);
            setPendingExternalAuthServerMismatch(
                serverMismatch,
            );
            localSearchParamsMock.mockReturnValue(params);

            await runWithOAuthScreen(async () => {
                await flushOAuthEffects(12);
                expect(
                    resumeAccountEncryptionFirstKeyExternalAuthSpy,
                ).not.toHaveBeenCalled();
                expect(
                    clearPendingExternalAuthMock,
                ).toHaveBeenCalled();
                expect(
                    clearPendingExternalAuthMock.mock.calls
                        .every((call) => call.length === 0),
                ).toBe(true);
                await expect(
                    readPendingExternalAuthStateMock(),
                ).resolves.toEqual({
                    value: marked,
                    serverMismatch,
                });
            });
        },
    );

    it('resumes a first-key migration before persisting the proposed E2EE credentials', async () => {
        setAuthState({
            isAuthenticated: true,
            credentials: { token: 'plain-token' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_encryption_first_key',
            pending: 'oauth-pending',
        });
        const fetchMock = vi.fn();
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(
                resumeAccountEncryptionFirstKeyExternalAuthSpy,
            ).toHaveBeenCalledWith({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: { token: 'plain-token' },
                persistCredentials: loginWithCredentialsSpy,
            });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
        });
    });

    it('redirects a retained first-key persistence failure to Settings recovery', async () => {
        setAuthState({
            isAuthenticated: true,
            credentials: { token: 'plain-token' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_encryption_first_key',
            pending: 'oauth-pending',
        });
        resumeAccountEncryptionFirstKeyExternalAuthSpy
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            );

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(modal.alert).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
        });
    });

    it('keeps the callback URL when the OAuth handle could not be placed in durable first-key custody', async () => {
        setAuthState({
            isAuthenticated: true,
            credentials: { token: 'plain-token' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_encryption_first_key',
            pending: 'oauth-pending',
        });
        resumeAccountEncryptionFirstKeyExternalAuthSpy
            .mockRejectedValueOnce(
                new HappyError(
                    'first-key-pending-custody-failed',
                    false,
                    {
                        status: 500,
                        kind: 'unknown',
                        code:
                            'first-key-pending-custody-failed',
                    },
                ),
            );

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(modal.alert).toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
        });
    });

    it('clears the proposed key and preserves plain credentials when first-key OAuth is cancelled', async () => {
        setAuthState({
            isAuthenticated: true,
            credentials: { token: 'plain-token' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_encryption_first_key',
            error: 'access_denied',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(
                resumeAccountEncryptionFirstKeyExternalAuthSpy,
            ).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(
                t('common.error'),
                'access_denied',
            );
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
        });
    });

    it('rejects a first-key continuation when the callback purpose is missing', async () => {
        setAuthState({
            isAuthenticated: true,
            credentials: { token: 'plain-token' },
        });
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'browser-proof',
            secret: 'proposed-secret',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'plain',
            pending: 'oauth-pending',
        });
        const fetchMock = vi.fn();
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(
                resumeAccountEncryptionFirstKeyExternalAuthSpy,
            ).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(
                t('common.error'),
                t('errors.oauthStateMismatch'),
            );
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
        });
    });

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

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.oauthStateMismatch'));
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
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

        const fetchMock = vi.fn(async (url: any, init?: any) => {
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
                return new Response(JSON.stringify({ success: true, token: 'tok_1' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: 'tok_1' });
            expect(getRandomBytesSpy).not.toHaveBeenCalled();
            expect(trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('preserves pending custody and suppresses OAuth success effects when credential recovery fails', async () => {
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'plain',
            pending: 'p1',
        });
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'proof_1',
        });
        loginWithCredentialsSpy.mockResolvedValueOnce({
            kind: 'recovery_failed',
        });
        setRuntimeFetch(vi.fn(async () => new Response(
            JSON.stringify({ success: true, token: 'replacement-token' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        )) as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({
                token: 'replacement-token',
            });
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            expect(trackAccountRestoredSpy).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            expect(modal.alertAsync).not.toHaveBeenCalled();
        });
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

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/restore');
        });
    });
});

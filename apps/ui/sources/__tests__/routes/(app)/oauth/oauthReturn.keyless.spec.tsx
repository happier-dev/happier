import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    cancelAccountPasswordEnrollmentExternalAuthSpy,
    clearAccountPasswordEnrollmentExternalAuthCustodySpy,
    clearPendingExternalAuthMock,
    flushOAuthEffects,
    getRandomBytesSpy,
    localSearchParamsMock,
    loginWithCredentialsSpy,
    maybeCompleteAuthSessionSpy,
    modal,
    readPendingExternalAuthStateMock,
    readAccountPasswordEnrollmentExternalAuthCallbackContextSpy,
    recordTeamInvitationPostAuthContinuationMock,
    replaceSpy,
    resetOAuthHarness,
    resumeAccountEncryptionFirstKeyExternalAuthSpy,
    resumeAccountPasswordEnrollmentExternalAuthSpy,
    runWithOAuthScreen,
    setAuthState,
    setStoredCredentialsState,
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
    it('completes a web popup callback without running the callback realm as an enrollment owner', async () => {
        maybeCompleteAuthSessionSpy.mockReturnValueOnce({
            type: 'success',
            message: 'Auth session completed',
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
        });
    });

    it('custodies a password-enrollment callback for the exact Home and resumes Account Security', async () => {
        const credentials = { token: 'plain-token' } as const;
        setAuthState({ isAuthenticated: true, credentials });
        readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReturnValue({
            target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
        });
        setStoredCredentialsState(credentials);
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).toHaveBeenCalledWith({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: credentials,
                target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
            });
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account/security?verificationToken=mailbox-proof',
            );
        });
    });

    it('clears cancelled password-enrollment proof custody and returns with the verified mailbox token', async () => {
        const credentials = { token: 'plain-token' } as const;
        setAuthState({ isAuthenticated: true, credentials });
        setStoredCredentialsState(credentials);
        readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReturnValue({
            target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            error: 'access_denied',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(cancelAccountPasswordEnrollmentExternalAuthSpy).toHaveBeenCalledWith({
                provider: 'github',
                currentCredentials: credentials,
                target: {
                    serverId: 'home-a',
                    serverUrl: 'https://home-a.example.test',
                },
            });
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account/security?verificationToken=mailbox-proof',
            );
        });
    });

    it('requires the originating process memory and does not resume after reload', async () => {
        setAuthState({ isAuthenticated: true, credentials: { token: 'plain-token' } });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account/security');
        });
    });

    it('retires claimed password-enrollment custody when the callback route is abandoned', async () => {
        const credentials = { token: 'plain-token' } as const;
        setAuthState({ isAuthenticated: true, credentials });
        setStoredCredentialsState(credentials);
        readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReturnValue({
            target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
        });
        resumeAccountPasswordEnrollmentExternalAuthSpy.mockImplementationOnce(
            () => new Promise(() => undefined),
        );
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).toHaveBeenCalledOnce();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).not.toHaveBeenCalled();
        });

        expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).toHaveBeenCalledOnce();
    });

    it('rejects a password-enrollment continuation when the callback purpose is missing', async () => {
        setAuthState({ isAuthenticated: true, credentials: { token: 'plain-token' } });
        readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReturnValue({
            target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github', flow: 'auth', pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account/security');
        });
    });

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
                t('errors.operationFailed'),
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

    it('accepts the exact Team OAuth admission reference and continues finalization', async () => {
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'proof_team',
            serverId: 'server-a',
            serverUrl: 'http://default.example.test',
            teamContinuation: {
                v: 1,
                purpose: 'team_admission',
                admissionReference: 'attempt-exact',
                teamId: 'team-1',
                homeServerIdentityId: 'server-a',
                destination: { kind: 'team_sign_in', teamId: 'team-1' },
            },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'team_admission',
            accountMode: 'plain',
            pending: 'pending-team-exact',
            admissionReference: 'attempt-exact',
        });
        const fetchMock = vi.fn(async (url: unknown) => {
            if (typeof url === 'string' && url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                return new Response(JSON.stringify({
                    success: true,
                    token: 'team-token',
                    teamInvitationContinuation: {
                        v: 1,
                        kind: 'post_auth_invitation',
                        reference: 'pending-team-exact',
                        teamId: 'team-1',
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock.mock.calls.some(([url]) =>
                typeof url === 'string'
                && url.includes('/v1/auth/external/github/finalize-keyless'),
            )).toBe(true);
            expect(recordTeamInvitationPostAuthContinuationMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith(
                { token: 'team-token' },
                { signInMethodId: 'github', target: { serverId: 'server-a', serverUrl: 'http://default.example.test' } },
            );
            expect(replaceSpy).toHaveBeenCalledWith(
                '/teams/team-1/sign-in?target=server-a&postAuthInvitation=1',
            );
        });
    });

    /**
     * The continuation stores the Home's portable identity, but a device-local
     * profile id is a different namespace. Returning through `serverId` made the
     * Team page resolve the portable value as a local profile reference, which
     * can match an unrelated profile and cannot report an ambiguous Home. The
     * portable carrier is the one the Team sign-in owner documents.
     */
    it('returns a Team admission to the portable Home the continuation named, not a device-local profile id', async () => {
        replaceSpy.mockReset();
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'proof_team',
            serverId: 'local-profile-7',
            serverUrl: 'http://default.example.test',
            teamContinuation: {
                v: 1,
                purpose: 'team_admission',
                admissionReference: 'attempt-exact',
                teamId: 'team-1',
                homeServerIdentityId: 'home-identity-a',
                destination: { kind: 'team_sign_in', teamId: 'team-1' },
            },
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'team_admission',
            accountMode: 'plain',
            pending: 'pending-team-exact',
            admissionReference: 'attempt-exact',
        });
        setRuntimeFetch((vi.fn(async (url: unknown) => {
            if (typeof url === 'string' && url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                return new Response(JSON.stringify({
                    success: true,
                    token: 'team-token',
                    teamInvitationContinuation: {
                        v: 1,
                        kind: 'post_auth_invitation',
                        reference: 'pending-team-exact',
                        teamId: 'team-1',
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        })) as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith(
                { token: 'team-token' },
                {
                    signInMethodId: 'github',
                    target: {
                        serverId: 'local-profile-7',
                        serverUrl: 'http://default.example.test',
                    },
                },
            );
            expect(replaceSpy).toHaveBeenCalledWith(
                '/teams/team-1/sign-in?target=home-identity-a&postAuthInvitation=1',
            );
        });
    });

    /**
     * The invitation continuation is the exception, not the rule. A Team-scoped
     * sign-in that the Home admits without one — an existing effective member,
     * or any member of a JIT/provisioned Team — answers with a credential and
     * nothing else. That credential is the whole point of the round trip: it is
     * committed, the pending record is released, and the person lands on the
     * exact Home-qualified Team page without a post-auth invitation marker.
     */
    function teamPendingState(overrides: Readonly<{ serverId?: string; homeServerIdentityId?: string }> = {}) {
        return {
            provider: 'github',
            proof: 'proof_team',
            serverId: overrides.serverId ?? 'server-a',
            serverUrl: 'http://default.example.test',
            teamContinuation: {
                v: 1 as const,
                purpose: 'team_admission' as const,
                admissionReference: 'attempt-exact',
                teamId: 'team-1',
                homeServerIdentityId: overrides.homeServerIdentityId ?? 'server-a',
                destination: { kind: 'team_sign_in' as const, teamId: 'team-1' },
            },
        };
    }

    function teamCallbackParams() {
        return {
            provider: 'github',
            flow: 'auth',
            purpose: 'team_admission',
            accountMode: 'plain',
            pending: 'pending-team-exact',
            admissionReference: 'attempt-exact',
        };
    }

    function installTeamFinalizeAnswer(body: Record<string, unknown>, status = 200) {
        const fetchMock = vi.fn(async (url: unknown) => {
            if (typeof url === 'string' && url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                return new Response(JSON.stringify(body), {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        setRuntimeFetch(fetchMock as unknown as typeof fetch);
        return fetchMock;
    }

    function findTeamFailureAction(tree: { root: { findAll: (p: (n: any) => boolean) => any[] } }, testID: string) {
        const [node] = tree.root.findAll((candidate) =>
            candidate.props.testID === testID && typeof candidate.props.action === 'function');
        if (!node) throw new Error(`Expected ${testID} to render`);
        return node;
    }

    it('commits an existing-member Team sign-in that carries no invitation continuation', async () => {
        recordTeamInvitationPostAuthContinuationMock.mockClear();
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState({
            serverId: 'local-profile-7',
            homeServerIdentityId: 'home-identity-a',
        }));
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({ success: true, token: 'team-token' });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith(
                { token: 'team-token' },
                { signInMethodId: 'github', target: { serverId: 'local-profile-7', serverUrl: 'http://default.example.test' } },
            );
            expect(recordTeamInvitationPostAuthContinuationMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=home-identity-a');
        });
    });

    it('returns a mismatched invitation continuation to the Team page without claiming a post-auth invitation', async () => {
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({
            success: true,
            token: 'team-token',
            teamInvitationContinuation: {
                v: 1,
                kind: 'post_auth_invitation',
                reference: 'pending-team-exact',
                teamId: 'team-2',
            },
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.oauthStateMismatch'));
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=server-a');
        });
    });

    it('returns a replayed Team callback to the Team page instead of the Home root', async () => {
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({ error: 'invalid-pending' }, 400);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.oauthStateMismatch'));
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=server-a');
        });
    });

    it.each([
        {
            name: 'a policy revised mid-flow',
            status: 409,
            error: 'auth_provider_configuration_changed',
            title: t('teams.entry.providerChangedTitle'),
        },
        {
            name: 'a Team that did not admit the identity',
            status: 403,
            error: 'team_authentication_required',
            title: t('teams.entry.notProvisionedTitle'),
        },
        {
            name: 'Team sign-in unavailable on the Home',
            status: 503,
            error: 'team_authentication_unavailable',
            title: t('teams.entry.accessRemovedTitle'),
        },
    ])('presents $name in Team terms and keeps the Team destination', async ({ status, error, title }) => {
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({ error }, status);

        await runWithOAuthScreen(async (tree) => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            expect(tree.root.findAll((node) =>
                node.props.testID === 'oauth-team-failure-title' && node.props.children === title,
            ).length).toBeGreaterThan(0);

            const primary = findTeamFailureAction(tree, 'oauth-team-failure-action');
            await act(async () => { await primary.props.action(); });
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=server-a');

            const secondary = findTeamFailureAction(tree, 'oauth-team-failure-secondary-action');
            await act(async () => { await secondary.props.action(); });
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
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: 'tok_1' }, { signInMethodId: 'github' });
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
            }, { signInMethodId: 'github' });
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

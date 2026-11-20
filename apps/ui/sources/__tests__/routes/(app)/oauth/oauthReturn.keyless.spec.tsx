import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    cancelAccountPasswordEnrollmentExternalAuthSpy,
    clearAccountPasswordEnrollmentExternalAuthCustodySpy,
    clearPendingExternalAuthMock,
    flushOAuthEffects,
    localSearchParamsMock,
    maybeCompleteAuthSessionSpy,
    modal,
    readPendingExternalAuthStateMock,
    recordTeamInvitationPostAuthContinuationMock,
    replaceSpy,
    resetOAuthHarness,
    resumeAccountEncryptionFirstKeyExternalAuthSpy,
    resumeAccountPasswordEnrollmentExternalAuthSpy,
    runWithOAuthScreen,
    setAuthState,
    setActiveServerSnapshot,
    oauthNativeStorageBoundary,
    oauthDefaultHome,
    setPendingExternalAuthState,
    setPendingExternalAuthServerMismatch,
    trackAccountRestoredSpy,
} from '@/auth/providers/github/test/oauthReturnHarness';
import { t } from '@/text';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setOAuthRuntimeFetch as setRuntimeFetch, prepareOAuthHarness } from '@/auth/providers/github/test/oauthReturnHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage, ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, type PendingExternalAuth } from '@/auth/storage/tokenStorage';
import { createAccountEncryptionFirstKeyFixture } from '@/dev/testkit/fixtures/accountEncryptionFirstKey';
import { ExternalOAuthFinalizeAuthSuccessResponseSchema, ExternalOAuthErrorResponseSchema, ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { PasswordMutationPreparationResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { PlainAccountPasswordCredentialV1Schema, encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { AccountEncryptionMigrateSuccessResponseSchema, createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { startAccountPasswordEnrollmentExternalAuth, readAccountPasswordEnrollmentExternalAuthProof } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { pressTestInstanceAsync } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    resetOAuthHarness();
    retirePresentationNotice();
});

async function startPasswordEnrollment() {
    const credentials = { token: createAccountTokenForTests('account-1') };
    setActiveServerSnapshot({ serverId: 'srv_home-a', serverUrl: 'https://home-a.example.test' });
    setAuthState({ isAuthenticated: true, credentials });
    await prepareOAuthHarness();
    const snapshot = getActiveServerSnapshot();
    const target = { serverId: snapshot.serverId, serverUrl: snapshot.serverUrl };
    const targetCredential = PlainAccountPasswordCredentialV1Schema.parse({
        v: 1, kind: 'plain_password_hash', hash: {
            v: 1, algorithm: 'scrypt', parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
            digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
        },
    });
    setRuntimeFetch(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/auth/entry') return Response.json(AuthEntryProjectionV1Schema.parse({
            v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
            actions: [{ kind: 'authenticate', methodId: 'github', action: 'login', mode: 'keyless',
                origin: 'home', presentation: { displayName: 'GitHub' } }],
        }));
        if (url.pathname === '/v1/auth/password/mutation/challenge') return Response.json(PasswordMutationPreparationResponseV1Schema.parse({ targetCredential }));
        if (url.pathname === '/v1/auth/external/github/params') return Response.json(ExternalOAuthParamsResponseSchema.parse({ url: 'https://github.example.test/authorize' }));
        return new Response('{}', { status: 404 });
    });
    await expect(startAccountPasswordEnrollmentExternalAuth({
        accountId: 'account-1', currentCredentials: credentials, linkedProviderIds: ['github'],
        normalizedNativeEmail: 'person@example.test', newPassword: 'correct horse battery staple',
        returnTo: '/settings/account/security?verificationToken=mailbox-proof', target,
    })).resolves.toMatchObject({ kind: 'oauth', provider: 'github' });
    clearAccountPasswordEnrollmentExternalAuthCustodySpy.mockClear();
    return { credentials, target, targetCredential };
}

async function firstKeyPending(marked = false) {
    const fixture = await createAccountEncryptionFirstKeyFixture();
    await prepareOAuthHarness();
    const snapshot = getActiveServerSnapshot();
    const target = { serverId: snapshot.serverId, serverUrl: snapshot.serverUrl };
    const createdAt = Date.now();
    const pending = {
        provider: 'github', proof: 'browser-proof', secret: fixture.proposedCredentials.secret, ...target,
        returnTo: '/settings/account',
        accountEncryptionFirstKey: {
            accountId: fixture.accountId,
            requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: fixture.request,
                accountId: fixture.accountId, sourceMode: 'plain' }),
            requestJson: JSON.stringify(fixture.request), createdAt,
            expiresAt: createdAt + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
            ...(marked ? { pending: 'oauth-pending', migrationSubmissionAttempted: true as const } : {}),
        },
    };
    return { ...fixture, target, pending };
}

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
        const { credentials, target, targetCredential } = await startPasswordEnrollment();
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
                target,
            });
            await expect(readAccountPasswordEnrollmentExternalAuthProof({
                accountId: 'account-1', currentCredentials: credentials, target,
            })).resolves.toMatchObject({ targetCredential, externalAuthProof: { provider: 'github', pending: 'oauth-pending' } });
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account/security?verificationToken=mailbox-proof',
            );
        });
    });

    it('clears cancelled password-enrollment proof custody and returns with the verified mailbox token', async () => {
        const { credentials, target } = await startPasswordEnrollment();
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
                target,
            });
            await expect(readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-1', currentCredentials: credentials, target })).resolves.toBeNull();
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account/security?verificationToken=mailbox-proof',
            );
        });
    });

    it('requires the originating process memory and does not resume after reload', async () => {
        setAuthState({ isAuthenticated: true, credentials: { token: createAccountTokenForTests('plain-token') } });
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
        const { credentials, target } = await startPasswordEnrollment();
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'account_password_enrollment',
            error: 'access_denied',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(modal.alert).not.toHaveBeenCalled();
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).not.toHaveBeenCalled();
        });

        expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).toHaveBeenCalledOnce();
        await expect(readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-1',
            currentCredentials: credentials, target })).resolves.toBeNull();
    });

    it('rejects a password-enrollment continuation when the callback purpose is missing', async () => {
        const { credentials, target } = await startPasswordEnrollment();
        localSearchParamsMock.mockReturnValue({
            provider: 'github', flow: 'auth', pending: 'oauth-pending',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(resumeAccountPasswordEnrollmentExternalAuthSpy).not.toHaveBeenCalled();
            expect(clearAccountPasswordEnrollmentExternalAuthCustodySpy).toHaveBeenCalled();
            await expect(readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-1', currentCredentials: credentials, target })).resolves.toBeNull();
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
            name: 'missing purpose after Home focus changes',
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
            const { pending: marked } = await firstKeyPending(true);
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
                await expect(
                    readPendingExternalAuthStateMock(),
                ).resolves.toEqual({
                    value: marked,
                    serverMismatch: false,
                });
                if (serverMismatch) {
                    await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({ value: marked, serverMismatch: true });
                }
            });
        },
    );

    it('resumes a first-key migration before persisting the proposed E2EE credentials', async () => {
        const fixture = await firstKeyPending();
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        await prepareOAuthHarness();
        let settleMigration: ((response: Response) => void) | undefined;
        const requests = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname === '/v1/account/encryption/migrate') {
                return new Promise<Response>((resolve) => { settleMigration = resolve; });
            }
            return new Response('{}', { status: 404 });
        });
        const request = setRuntimeFetch(requests);
        connection = await restoreServerAccountForTest({ ...fixture.target,
            serverIdentityId: fixture.target.serverId, accountId: fixture.accountId,
            credentials: fixture.currentCredentials, request });
        setPendingExternalAuthState(fixture.pending);
        localSearchParamsMock.mockReturnValue({ provider: 'github', flow: 'auth',
            purpose: 'account_encryption_first_key', pending: 'oauth-pending' });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(requests.mock.calls.some(([input]) => new URL(String(input)).pathname === '/v1/account/encryption/migrate')).toBe(true);
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
            expect(settleMigration).toBeDefined();
            await act(async () => { settleMigration?.(Response.json(AccountEncryptionMigrateSuccessResponseSchema.parse({
                success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4,
            }))); });
            await flushOAuthEffects(12);
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.proposedCredentials);
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });
    });

    it('redirects a retained first-key persistence failure to Settings recovery', async () => {
        const fixture = await firstKeyPending();
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        await prepareOAuthHarness();
        const requests = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/v1/account/encryption/migrate'
            ? Response.json(AccountEncryptionMigrateSuccessResponseSchema.parse({ success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4 }))
            : new Response('{}', { status: 404 }));
        const request = setRuntimeFetch(requests);
        connection = await restoreServerAccountForTest({ ...fixture.target,
            serverIdentityId: fixture.target.serverId, accountId: fixture.accountId,
            credentials: fixture.currentCredentials, request });
        setPendingExternalAuthState(fixture.pending);
        await prepareOAuthHarness();
        let failedCredentialWrite = false;
        oauthNativeStorageBoundary.beforeWrite = (_key, value) => {
            if (value.includes('"token":') && value.includes('"secret":')) {
                failedCredentialWrite = true;
                throw new Error('credential storage unavailable');
            }
        };
        localSearchParamsMock.mockReturnValue({ provider: 'github', flow: 'auth',
            purpose: 'account_encryption_first_key', pending: 'oauth-pending' });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(failedCredentialWrite).toBe(true);
            expect(modal.alert).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toMatchObject({
                accountEncryptionFirstKey: { pending: 'oauth-pending', migrationSubmissionAttempted: true },
            });
        });
    });

    it('keeps the callback URL when the OAuth handle could not be placed in durable first-key custody', async () => {
        const fixture = await firstKeyPending();
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        setPendingExternalAuthState(fixture.pending);
        await prepareOAuthHarness();
        oauthNativeStorageBoundary.beforeWrite = (_key, value) => {
            if (value.includes('"migrationSubmissionAttempted":true')) throw new Error('native custody storage unavailable');
        };
        localSearchParamsMock.mockReturnValue({ provider: 'github', flow: 'auth',
            purpose: 'account_encryption_first_key', pending: 'oauth-pending' });
        const requests = vi.fn(async () => new Response('{}', { status: 404 }));
        setRuntimeFetch(requests);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(12);
            expect(modal.alert).toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            expect(requests).not.toHaveBeenCalled();
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(fixture.pending);
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
        });
    });

    it('clears the proposed key and preserves plain credentials when first-key OAuth is cancelled', async () => {
        const fixture = await firstKeyPending();
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        setPendingExternalAuthState(fixture.pending);
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
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
            expect(readPresentationNotice()).toMatchObject({
                key: 'oauth-return',
                severity: 'info',
                message: t('errors.oauthCancelled'),
            });
        });
    });

    it('rejects a first-key continuation when the callback purpose is missing', async () => {
        const fixture = await firstKeyPending();
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        setPendingExternalAuthState(fixture.pending);
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
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
            expect(modal.alert).toHaveBeenCalledWith(
                t('common.error'),
                t('errors.oauthStateMismatch'),
            );
            expect(replaceSpy).toHaveBeenCalledWith(
                '/settings/account',
            );
        });
    });

    it('names a failed managed GitHub sign-in and offers Back to the originating Home', async () => {
        const provider = 'e031151c-a419-4cc1-93ca-50d0a51f06a1';
        setPendingExternalAuthState({
            ...oauthDefaultHome, provider, proof: 'proof', mode: 'keyless', returnTo: '/setup/wizard',
            presentation: { displayName: 'GitHub', iconHint: 'github', providerKind: 'github_app_identity' },
        });
        localSearchParamsMock.mockReturnValue({
            provider, flow: 'auth', error: 'missing_access_token', error_description: 'unsafe provider text',
        });

        await runWithOAuthScreen(async (tree) => {
            const [failure] = tree.root.findAllByProps({ testID: 'oauth-external-failure' });
            expect(failure).toBeDefined();
            expect(failure.findAllByType(StepMark).map((mark) => mark.props.iconName)).toContain('github-logo');
            const result = JSON.stringify(tree.toJSON());
            expect(result).not.toContain(t('errors.operationFailed'));
            expect(result).not.toContain('unsafe provider text');
            expect(result).toContain(t('settingsAccount.accountServiceOAuth.errors.provider.body'));
            expect(replaceSpy).not.toHaveBeenCalled();
            await pressTestInstanceAsync(tree.root.findAllByProps({ testID: 'unauth-shell-back-chevron' })[0]);
            const home = resolveUniqueServerProfileByUrl(oauthDefaultHome.serverUrl);
            if (!home) throw new Error('Expected the originating Home profile');
            expect(replaceSpy).toHaveBeenCalledWith({
                pathname: '/server',
                params: { recoveryProfile: home.id, recoveryReturnTo: '/setup/wizard' },
            });
        });
    });

    it('rejects legacy pending auth without an exact Home URL after focus changes', async () => {
        replaceSpy.mockReset();
        clearPendingExternalAuthMock.mockClear();
        modal.alert.mockReset();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p-mismatch',
        });
        setPendingExternalAuthState({
            provider: 'github',
            proof: 'proof_mismatch',
            serverId: 'srv_server-a',
        });
        setPendingExternalAuthServerMismatch(true);

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async (tree) => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            await expect(TokenStorage.getCredentials()).resolves.toEqual(null);
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
            expect(tree.root.findAllByProps({ testID: 'oauth-external-failure-title' })
                .some((node) => node.props.children === t('settingsAccount.accountServiceOAuth.errors.invalid.title'))).toBe(true);
            await pressTestInstanceAsync(tree.root.findAllByProps({ testID: 'unauth-shell-back-chevron' })[0]);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('accepts the exact Team OAuth admission reference and continues finalization', async () => {
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'team_admission',
            accountMode: 'plain',
            pending: 'pending-team-exact',
            admissionReference: 'attempt-exact',
        });
        const fetchMock = installTeamFinalizeAnswer({ success: true, token: createAccountTokenForTests('team-account'),
            teamInvitationContinuation: { v: 1, kind: 'post_auth_invitation', reference: 'pending-team-exact', teamId: 'team-1' },
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock.mock.calls.some(([url]) =>
                typeof url === 'string'
                && url.includes('/v1/auth/external/github/finalize-keyless'),
            )).toBe(true);
            expect(recordTeamInvitationPostAuthContinuationMock).toHaveBeenCalled();
            await expect(TokenStorage.getCredentialsForServerUrl('http://default.example.test')).resolves.toEqual({ token: createAccountTokenForTests('team-account') });
            expect(replaceSpy).toHaveBeenCalledWith(
                '/teams/team-1/sign-in?target=srv_server-a&postAuthInvitation=1',
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
        setPendingExternalAuthState(teamPendingState({ homeServerIdentityId: 'srv_home-identity-a', serverUrl: 'https://team-home.example.test' }));
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            purpose: 'team_admission',
            accountMode: 'plain',
            pending: 'pending-team-exact',
            admissionReference: 'attempt-exact',
        });
        installTeamFinalizeAnswer({ success: true, token: createAccountTokenForTests('team-account'),
            teamInvitationContinuation: { v: 1, kind: 'post_auth_invitation', reference: 'pending-team-exact', teamId: 'team-1' },
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            const home = resolveUniqueServerProfileByUrl('https://team-home.example.test');
            expect(home).not.toBeNull();
            expect(home?.id).not.toBe('srv_home-identity-a');
            await expect(TokenStorage.getCredentialsForServerUrl('https://team-home.example.test')).resolves.toEqual({ token: createAccountTokenForTests('team-account') });
            expect(replaceSpy).toHaveBeenCalledWith(
                '/teams/team-1/sign-in?target=srv_home-identity-a&postAuthInvitation=1',
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
    function teamPendingState(overrides: Readonly<{ homeServerIdentityId?: string; serverUrl?: string }> = {}) {
        return {
            provider: 'github',
            proof: 'proof_team',
            serverId: overrides.homeServerIdentityId ?? 'srv_server-a',
            serverUrl: overrides.serverUrl ?? 'http://default.example.test',
            teamContinuation: {
                v: 1 as const,
                purpose: 'team_admission' as const,
                admissionReference: 'attempt-exact',
                teamId: 'team-1',
                homeServerIdentityId: overrides.homeServerIdentityId ?? 'srv_server-a',
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
                return new Response(JSON.stringify(status === 200 ? ExternalOAuthFinalizeAuthSuccessResponseSchema.parse(body) : ExternalOAuthErrorResponseSchema.parse(body)), {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
        });
        setRuntimeFetch(fetchMock as unknown as typeof fetch);
        return fetchMock;
    }

    it('commits an existing-member Team sign-in that carries no invitation continuation', async () => {
        recordTeamInvitationPostAuthContinuationMock.mockClear();
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState({
            homeServerIdentityId: 'srv_home-identity-a', serverUrl: 'https://team-home.example.test',
        }));
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({ success: true, token: createAccountTokenForTests('team-account') });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(recordTeamInvitationPostAuthContinuationMock).not.toHaveBeenCalled();
            await expect(TokenStorage.getCredentialsForServerUrl('https://team-home.example.test')).resolves.toEqual({ token: createAccountTokenForTests('team-account') });
            await expect(TokenStorage.readPendingExternalAuthStateForServerUrl('https://team-home.example.test', {
                serverId: 'srv_home-identity-a',
            })).resolves.toEqual({ value: null, serverMismatch: false });
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=srv_home-identity-a');
        });
    });

    it('returns a mismatched invitation continuation to the Team page without claiming a post-auth invitation', async () => {
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({
            success: true,
            token: createAccountTokenForTests('team-account'),
            teamInvitationContinuation: {
                v: 1,
                kind: 'post_auth_invitation',
                reference: 'pending-team-exact',
                teamId: 'team-2',
            },
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            await expect(TokenStorage.getCredentials()).resolves.toEqual(null);
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.oauthStateMismatch'));
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=srv_server-a');
        });
    });

    it('returns a replayed Team callback to the Team page instead of the Home root', async () => {
        clearPendingExternalAuthMock.mockClear();
        setPendingExternalAuthState(teamPendingState());
        localSearchParamsMock.mockReturnValue(teamCallbackParams());
        installTeamFinalizeAnswer({ error: 'invalid-pending' }, 400);

        await runWithOAuthScreen(async (tree) => {
            await flushOAuthEffects();
            await expect(TokenStorage.getCredentials()).resolves.toEqual(null);
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            await pressTestInstanceAsync(tree.root.findAllByProps({ testID: 'unauth-shell-back-chevron' })[0]);
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=srv_server-a');
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
            await expect(TokenStorage.getCredentials()).resolves.toEqual(null);
            expect(clearPendingExternalAuthMock).toHaveBeenCalled();
            expect(modal.alert).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            expect(tree.root.findAll((node) =>
                node.props.testID === 'oauth-team-failure-title' && node.props.children === title,
            ).length).toBeGreaterThan(0);

            const pressAction = (testID: string) => pressTestInstanceAsync(tree.root.findAll((node) =>
                node.props.testID === testID && typeof node.props.onPress === 'function',
            ).at(-1), testID);
            await pressAction('oauth-team-failure-action');
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=srv_server-a');

            await pressAction('oauth-team-failure-secondary-action');
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('finalizes keyless oauth auth for a plaintext account and logs in with token-only credentials', async () => {
        replaceSpy.mockReset();
        clearPendingExternalAuthMock.mockClear();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'plain',
            pending: 'p1',
        });
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_1' });

        const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (typeof url === 'string' && url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
                const body = JSON.parse(String(init?.body ?? '{}'));
                expect(body).toEqual({ pending: 'p1', proof: 'proof_1' });
                return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_1') })), {
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
            await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: createAccountTokenForTests('tok_1') });
            expect(trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/');
        });
    });

    it('preserves pending custody and suppresses OAuth success effects when credential recovery fails', async () => {
        const fixture = await firstKeyPending(true);
        modal.show.mockImplementationOnce(() => 'modal-id');
        let retained: PendingExternalAuth = fixture.pending;
        setAuthState({ isAuthenticated: true, credentials: fixture.currentCredentials });
        localSearchParamsMock.mockReturnValue({ provider: 'github', flow: 'auth', accountMode: 'plain', pending: 'p1' });
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_1' });
        setRuntimeFetch(async (input) => {
            if (new URL(String(input)).pathname === '/v1/auth/external/github/finalize-keyless') {
                // This boundary response races a separately admitted first-key attempt.
                expect(await TokenStorage.setPendingExternalAuth(fixture.pending, fixture.target)).toBe(true);
                const marked = await TokenStorage.markPendingExternalAuthFirstKeyRejectedCredential({
                    expected: fixture.pending, token: fixture.currentCredentials.token, ...fixture.target,
                });
                if (marked.kind !== 'recorded') throw new Error('Expected rejected credential custody');
                retained = marked.pending;
                return Response.json(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: fixture.currentCredentials.token }));
            }
            return Response.json({ error: 'encryption temporarily unavailable' }, { status: 503 });
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            const config = modal.show.mock.calls.at(-1)?.[0];
            expect(config).toBeDefined();
            const finish = (config as unknown as { props: { finish: () => Promise<unknown> } }).props.finish;
            await expect(finish()).resolves.toEqual({ kind: 'recovery_failed' });
            await expect(TokenStorage.getCredentials()).resolves.toEqual(fixture.currentCredentials);
            await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(retained);
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            expect(trackAccountRestoredSpy).not.toHaveBeenCalled();
            expect(replaceSpy).not.toHaveBeenCalled();
            expect(modal.alertAsync).not.toHaveBeenCalled();
            config?.onRequestClose?.();
            await flushOAuthEffects();
        });
    });

    it('redirects to /restore for an e2ee account (without attempting keyless finalize)', async () => {
        replaceSpy.mockReset();
        clearPendingExternalAuthMock.mockClear();

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            accountMode: 'e2ee',
            pending: 'p2',
        });
        setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_2' });

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(clearPendingExternalAuthMock).not.toHaveBeenCalled();
            await expect(TokenStorage.getCredentials()).resolves.toEqual(null);
            expect(replaceSpy).toHaveBeenCalledWith('/restore');
        });
    });
});

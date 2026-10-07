import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import {
    encodePasswordCredentialFieldV1,
    type PlainAccountPasswordCredentialV1,
    type AccountSecurityGetResponseV1,
} from '@happier-dev/protocol';

import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { setCurrentAuth } from '@/auth/context/currentAuth';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import {
    reconcileServerProfileHomeConnectionDescriptor,
    resolveServerProfileScopeIdForIdentifier,
    setServerProfileIdentityForUrl,
} from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createAccountSecurityActionClient } from '@/components/settings/account/accountSecurityActionClient';
import { describeEmailPasswordFailure } from '@/components/account/auth/emailPassword/emailPasswordFormModel';
import { AuthProvider, getCurrentAuth } from '@/auth/context/AuthContext';
import { AccountEmailPasswordSection } from '@/components/settings/account/AccountEmailPasswordSection';
import { resetAccountSecurityProjectionStoreForTests } from '@/components/settings/account/accountSecurityProjectionStore';
import { renderScreen } from '@/dev/testkit';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';

installDisconnectedServerSocketBoundary();
const initialState = getStorage().getState();
const tokenWithPayload = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const enrolledSecuritySummary = {
    v: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed', nativeEmail: 'person@example.test',
    password: { status: 'enrolled', revision: 4 },
} satisfies AccountSecurityGetResponseV1;

describe('default Account Security Action transport', () => {
    let serverId: string;
    let securityResponseOverride: Promise<Response> | null;
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    let previousAuth: ReturnType<typeof getCurrentAuth>;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let securityRequest: RuntimeFetch;
    const requests: Array<{ path: string; method: string; body: unknown }> = [];

    beforeEach(async () => {
        previousAuth = getCurrentAuth();
        setCurrentAuth(null);
        await loadSyncSingletonForTests();
        getStorage().setState(initialState, true);
        resetAccountSecurityProjectionStoreForTests();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
        invalidateAccountEncryptionModeCache();
        const profile = await upsertAndActivateServer({ serverUrl: 'https://security-actions.test', name: 'Security Home' });
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_security_actions');
        serverId = profile.id;
        securityResponseOverride = null;
        getStorage().getState().activateProfileScope({ serverId, accountId: 'account-a' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('account-a') });
        requests.length = 0;
        securityRequest = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            requests.push({ path, method: init?.method ?? 'GET', body });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_security_actions' } } }));
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/security') {
                if (securityResponseOverride) return await securityResponseOverride;
                return Response.json(enrolledSecuritySummary);
            }
            if (path === '/v1/account/email/change/request') return Response.json({ v: 1, status: 'verification_sent' });
            const status = path.endsWith('/remove') ? 'removed' : path.endsWith('/enroll') ? 'enrolled' : 'updated';
            return Response.json({ v: 1, status });
        };
        setRuntimeFetch(securityRequest);
    });

    afterEach(async () => {
        await screen?.unmount();
        await connection?.dispose();
        connection = undefined;
        setCurrentAuth(previousAuth);
        await disposeIrohHomeTunnelRuntime();
        screen = null;
        vi.unstubAllGlobals();
        resetRuntimeFetch();
        vi.restoreAllMocks();
        getStorage().setState(initialState, true);
        invalidateAccountEncryptionModeCache();
    });

    it('projects closed installed credential kinds without promoting terminals or malformed bearers', async () => {
        const cases = [
            [createAccountTokenForTests('account-a'), 'account'],
            [tokenWithPayload({ sub: 'account-a', session: 'released-terminal' }), 'terminal'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 1, kind: 'account', authority: 'present_user' } }), 'account'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } }), 'terminal'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 1, kind: 'account_directory', authority: 'present_user' } }), 'none'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 1, kind: 'ephemeral_session_runner', authority: 'session_runtime' } }), 'none'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 3, kind: 'account', authority: 'present_user' } }), 'none'],
            [tokenWithPayload({ sub: 'account-a', provenance: { v: 1, kind: 'terminal', authority: 'present_user' } }), 'none'],
            ['malformed-bearer', 'none'],
            ['hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43), 'api_token'],
        ] as const;
        for (const [token, credentialAuthorityKind] of cases) {
            screen = await renderScreen(React.createElement(AuthProvider, {
                initialCredentials: { token }, children: React.createElement(React.Fragment),
            }));
            expect(getCurrentAuth()).toMatchObject({ credentialAuthorityKind });
            await screen.unmount();
            screen = null;
        }
    });

    it('refuses automation surfaces even when the caller supplies present-user authority', async () => {
        const executor = createDefaultActionExecutor();
        for (const surface of ['voice', 'plugin'] as const) {
            const result = await executor.execute('approval.request.decide', { artifactId: 'missing', decision: 'approve' }, {
                serverId, surface, authority: 'present_user', bypassApprovals: true,
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        }
        expect(requests.some(({ path }) => path.startsWith('/v1/artifacts'))).toBe(false);
    });

    it('refuses a terminal bearer on the UI even when the caller supplies present-user authority', async () => {
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: tokenWithPayload({
            sub: 'account-a', provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
        }) });
        await expect(createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: 'missing', decision: 'approve',
        }, { serverId, surface: 'ui', authority: 'present_user', bypassApprovals: true })).resolves.toMatchObject({
            ok: false, errorCode: 'present_user_required',
        });
    });

    it('admits account UI authority on the captured Home', async () => {
        const executor = createDefaultActionExecutor();
        await expect(executor.execute('account.security.get', {}, { serverId, surface: 'ui' })).resolves.toMatchObject({ ok: true });
    });

    async function openPasswordForm() {
        const credentials = { token: createAccountTokenForTests('account-a') };
        getStorage().setState({ profile: { ...getStorage().getState().profile, id: 'account-a' } });
        getStorage().getState().applySettingsForScope(
            { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' },
            getStorage().getState().settings, 1,
        );
        const executor = createDefaultActionExecutor();
        const client = createAccountSecurityActionClient({
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, bypassApprovals: true }),
            resolveServerId: () => serverId,
        });
        screen = await renderScreen(React.createElement(AuthProvider, { initialCredentials: credentials, children:
            React.createElement(AccountEmailPasswordSection, { client }),
        }));
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
        await screen.pressByTestIdAsync('settings-account-password');
        await act(async () => {
            screen?.changeTextByTestId('settings-account-current-password', 'current-password-value');
            screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
            screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
        });
        return screen;
    }

    it('allows mounted cancellation during Action credential admission without issuing a password write', async () => {
        const view = await openPasswordForm();
        let release!: (value: { token: string }) => void;
        const credentials = new Promise<{ token: string }>((resolve) => { release = resolve; });
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockReturnValueOnce(credentials);
        act(() => { view.pressByTestId('settings-account-change-password-submit'); });
        await act(async () => { await Promise.resolve(); });
        await view.pressByTestIdAsync('settings-account-password-form-cancel');
        release({ token: createAccountTokenForTests('account-a') });
        await act(async () => { await credentials; });
        expect(requests.some(({ path }) => path === '/v1/account/password/change')).toBe(false);
        await view.pressByTestIdAsync('settings-account-password');
        await vi.waitFor(() => expect(view.findByTestId('settings-account-new-password')?.props.editable).toBe(true));
    }, 180_000);

    it('shows mounted unknown-effect recovery when cancelling an issued password write', async () => {
        const view = await openPasswordForm();
        let mutationIssued = false;
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/password/change') {
                mutationIssued = true;
                return await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
            }
            return Response.json(enrolledSecuritySummary);
        });
        act(() => { view.pressByTestId('settings-account-change-password-submit'); });
        await vi.waitFor(() => expect(mutationIssued).toBe(true));
        await view.pressByTestIdAsync('settings-account-password-form-cancel');
        await vi.waitFor(() => expect(view.getTextContent()).toContain(nativePasswordTranslations.en.outcomeUnconfirmed));
        expect(view.findByTestId('settings-account-new-password')?.props.editable).toBe(true);
    }, 180_000);

    it('dispatches all five operations to the captured Home and keeps secret mutations present-user-only', async () => {
        const execute = createDefaultActionExecutor().execute;
        const targetCredential = {
            v: 1,
            kind: 'plain_password_hash',
            hash: {
                v: 1,
                algorithm: 'scrypt',
                parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
            },
        } as const satisfies PlainAccountPasswordCredentialV1;
        const reauthentication = {
            provider: 'github',
            pending: 'pending-a',
            proof: 'proof-a',
        } as const;
        await expect(execute('account.security.get', {}, {
            serverId, surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' },
        })).resolves.toMatchObject({ ok: true, result: { nativeEmail: 'person@example.test' } });
        await expect(execute('account.password.enroll', {
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential,
            reauthentication,
        }, { serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true })).resolves.toMatchObject({ ok: true });
        await expect(execute('account.password.change', {
            v: 1, kind: 'plain', expectedCredentialRevision: 4,
            currentPassword: 'a sufficiently long password', newPassword: 'a different sufficiently long password',
        }, { serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true })).resolves.toMatchObject({ ok: true });
        await expect(execute('account.password.remove', {
            v: 1, kind: 'plain', expectedCredentialRevision: 4, currentPassword: 'a sufficiently long password',
        }, { serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true })).resolves.toMatchObject({ ok: true });
        await expect(execute('account.email.change.request', { v: 1, email: 'next@example.test' }, {
            serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true,
        })).resolves.toMatchObject({ ok: true });

        expect(requests.filter(({ path }) => path.startsWith('/v1/account/')).map(({ path }) => path)).toEqual(expect.arrayContaining([
            '/v1/account/security', '/v1/account/password/enroll', '/v1/account/password/change',
            '/v1/account/password/remove', '/v1/account/email/change/request',
        ]));
        const enrollRequest = requests.find(({ path }) => path === '/v1/account/password/enroll');
        expect(enrollRequest?.body).toEqual({
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential,
            reauthentication,
        });
        expect(enrollRequest?.body).not.toHaveProperty('password');
        expect(enrollRequest?.body).not.toHaveProperty('requestDigest');
        await expect(execute('account.password.remove', {
            v: 1, kind: 'plain', expectedCredentialRevision: 4, currentPassword: 'a sufficiently long password',
        }, { serverId, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } })).resolves.toMatchObject({
            ok: false,
        });
    }, 180_000);

    it('reads Account Security without first reading the Account encryption mode it does not use', async () => {
        // As in the app: the signed-in Account's settings are already the active settings.
        getStorage().getState().applySettingsForScope(
            { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' },
            getStorage().getState().settings,
            1,
        );
        await expect(createDefaultActionExecutor().execute('account.security.get', {}, {
            serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).resolves.toMatchObject({ ok: true });

        expect(requests.map(({ path }) => path)).toContain('/v1/account/security');
        expect(requests.map(({ path }) => path)).not.toContain('/v1/account/encryption');
    }, 180_000);

    it('keeps credential preflight failure determinate before a password write', async () => {
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRejectedValueOnce(new TypeError('credential store unavailable'));
        const client = createAccountSecurityActionClient({ resolveServerId: () => serverId });
        let failure: unknown;
        try {
            await client.changePlainPassword({
                expectedCredentialRevision: 4,
                currentPassword: 'current password',
                newPassword: 'replacement password',
            });
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect(requests.some(({ path }) => path === '/v1/account/password/change')).toBe(false);
        expect(describeEmailPasswordFailure(failure).messageKey).toBe('settingsAccount.nativePassword.offline');
    }, 180_000);

    it.each([false, true])('preserves a lost password-write verdict through the real Action client (cancelled: %s)', async (cancelled) => {
        getStorage().getState().applySettingsForScope(
            { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' },
            getStorage().getState().settings,
            1,
        );
        const controller = new AbortController();
        setRuntimeFetch(async () => {
            if (cancelled) controller.abort();
            throw new TypeError('Network request failed');
        });
        const executor = createDefaultActionExecutor();
        const client = createAccountSecurityActionClient({
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, bypassApprovals: true }),
            resolveServerId: () => serverId,
        });
        await expect(client.changePlainPassword({
            expectedCredentialRevision: 4, currentPassword: 'current password', newPassword: 'replacement password',
        }, controller.signal)).rejects.toMatchObject({ code: 'outcome_unknown' });
    }, 180_000);

    it('preserves a typed Home refusal through the real Action client', async () => {
        getStorage().getState().applySettingsForScope(
            { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' },
            getStorage().getState().settings, 1,
        );
        setRuntimeFetch(async () => Response.json({ error: 'credential_revision_conflict' }, { status: 409 }));
        const executor = createDefaultActionExecutor();
        const client = createAccountSecurityActionClient({
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, bypassApprovals: true }),
            resolveServerId: () => serverId,
        });
        await expect(client.changePlainPassword({
            expectedCredentialRevision: 4, currentPassword: 'current password', newPassword: 'replacement password',
        })).rejects.toMatchObject({ code: 'credential_revision_conflict' });
    }, 180_000);

    it('says the Home is unreachable, never that the password is wrong, when the read cannot reach it', async () => {
        getStorage().getState().applySettingsForScope(
            { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' },
            getStorage().getState().settings, 1,
        );
        setRuntimeFetch(async () => { throw new TypeError('Failed to fetch'); });
        const executor = createDefaultActionExecutor();
        const client = createAccountSecurityActionClient({
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, bypassApprovals: true }),
            resolveServerId: () => serverId,
        });
        const failure = await client.read().then(() => null, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'server_unreachable' });
        const problem = describeEmailPasswordFailure(failure);
        expect(problem.field).toBe('form');
        expect(problem.messageKey).toBe('settingsAccount.nativePassword.homeUnreachable');
    }, 180_000);

    it('retires an in-flight Account Security result when the active Home changes', async () => {
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://security-actions.test', accountId: 'account-a', request: securityRequest,
        });
        let release: ((response: Response) => void) | undefined;
        securityResponseOverride = new Promise<Response>((resolve) => { release = resolve; });
        const execution = createDefaultActionExecutor().execute('account.security.get', {}, {
            serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        await vi.waitFor(() => expect(requests.some(({ path }) => path === '/v1/account/security')).toBe(true));

        await connection.dispose();
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://other-home.test', accountId: 'account-b', request: securityRequest,
        });
        release?.(Response.json({
            ...enrolledSecuritySummary, nativeEmail: 'must-not-escape@example.test',
            password: { status: 'not_enrolled', revision: null },
        }));

        await expect(execution).resolves.toMatchObject({ ok: false });
    }, 180_000);

    it('uses a verified scoped Iroh carrier for the captured Home', async () => {
        // Desktop/native tunnel creation is the OS boundary; carrier policy,
        // readiness, identity verification and Action transport remain real.
        vi.stubGlobal('isTauri', true);
        await disposeIrohHomeTunnelRuntime();
        getIrohHomeTunnelRuntime({ native: {
            ensureHomeTunnel: async (request) => ({
                leaseId: 'scoped-security-home',
                homeServerIdentityId: request.homeServerIdentityId,
                homeEndpointId: request.endpointId,
                runtimeOrigin: 'http://127.0.0.1:4101',
                carrier: 'iroh',
                observedPath: 'direct',
                startedAtMs: 1,
            }),
            releaseHomeTunnel: async () => undefined,
        } });
        const reconciled = await reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://security-actions.test',
            observedServerIdentityId: 'srv_security_actions',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_security_actions',
                canonicalServerUrl: 'https://security-actions.test',
                revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
            },
        });
        expect(reconciled.kind).toBe('applied');

        await expect(createDefaultActionExecutor().execute('account.security.get', {}, {
            serverId,
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
        })).resolves.toMatchObject({
            ok: true,
            result: { nativeEmail: 'person@example.test' },
        });
        expect(requests.some(({ path }) => path === '/v1/account/security')).toBe(true);
    }, 180_000);
});

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { act } from 'react-test-renderer';
import { AccountEncryptionMigrateRequestSchema, createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installLocalStorageMock, installWebLockManagerMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { PendingExternalAuth } from '@/auth/storage/tokenStorage';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary();
const boundary = vi.hoisted<{
    replace: ReturnType<typeof vi.fn>;
    params: { code: string; admissionReference: string | undefined };
}>(() => ({
    replace: vi.fn(),
    params: { code: 'mtls-code', admissionReference: undefined },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => boundary.params, router: { replace: boundary.replace },
}).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const importBrowser = installLocalStorageMock();
const importLocks = installWebLockManagerMock();
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
setRuntimeFetch(async () => { throw new Error('Unexpected mTLS HTTP request before fixture arrangement'); });
// The real app entry publishes the Sync producer before routes or connection cleanup run.
await loadSyncSingletonForTests();
const [
    { AuthProvider, getCurrentAuth, setCurrentAuth }, { default: Route },
    { adoptHomeProfile, setActiveServerId, getActiveServerUrl, removeServerProfile },
    { TokenStorage }, { storage }, { createDirectoryHttpFixture },
    { disconnectActiveServerConnection }, { stopAllEndpointSupervisorsForTests },
    { apiSocket }, { clearPersistence }, { resetSessionDraftRepositoryForTests },
    { guardAccountEncryptionFirstKeyCredentialMutation, abandonAccountEncryptionFirstKeyExternalAuth,
        markAccountEncryptionFirstKeyRejectedCredential },
    { encodeBase64 }, { deriveAccountSigningPublicKey }, { buildContentKeyBinding }, { Modal },
] = [
    await import('@/auth/context/AuthContext'), await import('@/app/(app)/mtls'),
    await import('@/sync/domains/server/serverProfiles'), await import('@/auth/storage/tokenStorage'),
    await import('@/sync/domains/state/storage'), await import('@/sync/ops/accountDirectory/accountDirectoryTestFixtures'),
    await import('@/sync/runtime/orchestration/connectionManager'), await import('@/sync/runtime/connectivity/endpointSupervisorPool'),
    await import('@/sync/api/session/apiSocket'), await import('@/sync/domains/state/persistence'),
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository'), await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth'),
    await import('@/encryption/base64'), await import('@/auth/flows/challenge'), await import('@/auth/oauth/contentKeyBinding'), await import('@/modal'),
];
resetRuntimeFetch();
importLocks.restore();
importBrowser.restore();
const initialStorageState = storage.getState();
const homes: Array<Readonly<{ id: string; serverUrl: string; serverIdentityId?: string | null }>> = [];

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let browser: LocalStorageMockHandle;
let restoreLocks: (() => void) | undefined;
let home: Readonly<{ id: string; serverUrl: string }>;
let token: string;
let claimResponse: unknown;
let failRecovery = false;
let request: ReturnType<typeof vi.fn<typeof import('@/utils/system/runtimeFetch')['runtimeFetch']>>;
let clearCustody: MockInstance<typeof import('@/auth/storage/tokenStorage')['TokenStorage']['clearPendingExternalAuth']>;
let login: MockInstance<NonNullable<ReturnType<typeof import('@/auth/context/AuthContext')['getCurrentAuth']>>['loginWithCredentials']>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});
const teamReturn = () => '/teams/team-1/sign-in?target=' + home.id;

beforeEach(async () => {
    vi.clearAllMocks();
    browser = installLocalStorageMock();
    restoreLocks = installWebLockManagerMock().restore;
    boundary.params = { code: 'mtls-code', admissionReference: undefined };
    failRecovery = false;
    const fixture = createDirectoryHttpFixture();
    token = fixture.token;
    claimResponse = { token };
    request = vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json({});
        if (url.pathname === '/v1/auth/mtls/claim') {
            expect(url.origin).toBe(home.serverUrl);
            return json(claimResponse);
        }
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') {
            const requestedHome = homes.find((candidate) => candidate.serverUrl === url.origin);
            if (!requestedHome) throw new Error(`Unexpected mTLS Home request: ${url.origin}`);
            return json(createRootLayoutFeaturesResponse({
                capabilities: { auth: { keyChallenge: { v2: true } },
                    serverIdentity: { serverIdentityId: requestedHome.serverIdentityId ?? requestedHome.id }, server: { canonicalServerUrl: url.origin },
                },
            }));
        }
        if (url.pathname === '/v1/auth/challenge' && failRecovery) {
            expect(url.origin).toBe(home.serverUrl);
            expect(JSON.parse(String(init?.body))).toEqual({ expectedAccountId: 'account-home' });
            return json({ error: 'internal' }, 503);
        }
        // Unavailable neighbouring reads do not fabricate Account data or authority.
        return json({ error: 'not-found' }, 404);
    });
    setRuntimeFetch(request);
    home = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://api.example.test',
        endpoints: [{ kind: 'https', url: 'https://api.example.test' }],
    }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    homes.push(home);
    const other = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        canonicalServerUrl: 'https://other.example.test', endpoints: [{ kind: 'https', url: 'https://other.example.test' }],
    }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    homes.push(other);
    await setActiveServerId(other.id, { scope: 'device' });
    await seedPending();
    clearCustody = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
});

afterEach(async () => {
    try {
        await screen?.unmount();
        screen = undefined;
        await disconnectActiveServerConnection();
        apiSocket.disconnect();
        await stopAllEndpointSupervisorsForTests();
        setCurrentAuth(null);
        for (const home of homes) {
            const target = { serverId: home.id, serverUrl: home.serverUrl };
            const guarded = await guardAccountEncryptionFirstKeyCredentialMutation(target);
            if (guarded.kind === 'finish_encryption_setup') {
                expect(await abandonAccountEncryptionFirstKeyExternalAuth(guarded.recovery)).toEqual({ kind: 'abandoned' });
            } else {
                expect(await TokenStorage.clearPendingExternalAuth(target)).toBe(true);
            }
            expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBe(true);
            await removeServerProfile(home.id);
        }
        homes.length = 0;
        await clearPersistence();
        resetSessionDraftRepositoryForTests();
        storage.setState(initialStorageState, true);
    } finally {
        resetRuntimeFetch();
        vi.restoreAllMocks();
        restoreLocks?.();
        browser.restore();
    }
});

async function seedPending(team = false) {
    const pending: PendingExternalAuth = { provider: 'mtls', serverId: home.id, serverUrl: home.serverUrl,
        ...(team ? { teamContinuation: { v: 1, purpose: 'team_admission', admissionReference: 'mtls-admission-1',
            teamId: 'team-1', homeServerIdentityId: home.id, destination: { kind: 'team_sign_in', teamId: 'team-1' },
        } } : { returnTo: '/setup/wizard' }),
    };
    expect(await TokenStorage.setPendingExternalAuth(pending,
        { serverId: home.id, serverUrl: home.serverUrl })).toBe(true);
    if (team) boundary.params.admissionReference = 'mtls-admission-1';
    return pending;
}
async function mountRoute() {
    screen = await renderScreen(<AuthProvider initialCredentials={null}><></></AuthProvider>);
    const auth = getCurrentAuth();
    if (!auth) throw new Error('Expected the real mounted AuthProvider');
    // Observation only: preserve the actual credential-adoption implementation.
    login = vi.spyOn(auth, 'loginWithCredentials');
    await screen.update(<AuthProvider initialCredentials={null}><Route /></AuthProvider>);
    await act(async () => {});
}
function claimCalls() {
    return request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/auth/mtls/claim');
}
async function assertRefused(destination: string) {
    await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith(destination));
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
    expect((await TokenStorage.readPendingExternalAuthContinuationState()).value).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(clearCustody).toHaveBeenCalledWith({ serverId: home.id, serverUrl: home.serverUrl });
}

describe('MtlsCallbackScreen', () => {
    it('uses runtimeFetch via serverFetch (not global fetch) to claim the mtls token', async () => {
        const globalFetch = vi.spyOn(globalThis, 'fetch');
        await mountRoute();
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith('/setup/wizard'));
        expect(claimCalls()).toHaveLength(1);
        expect(JSON.parse(String(claimCalls()[0]?.[1]?.body))).toEqual({ code: 'mtls-code' });
        expect(globalFetch).not.toHaveBeenCalled();
        expect(login).toHaveBeenCalledWith({ token }, { target: { serverId: home.id, serverUrl: home.serverUrl } });
        expect(clearCustody).toHaveBeenCalledWith({ serverId: home.id, serverUrl: home.serverUrl });
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token });
        expect((await TokenStorage.readPendingExternalAuthContinuationState()).value).toBeNull();
        expect(getActiveServerUrl()).toBe('https://other.example.test');
    });
    it('rejects an unexpected Team admission reference on an ordinary Home callback', async () => {
        boundary.params.admissionReference = 'mtls-admission-1';
        await mountRoute();
        await assertRefused('/setup/wizard');
        expect(claimCalls()).toHaveLength(0);
    });
    it('claims and completes the exact Team mTLS continuation', async () => {
        await seedPending(true);
        claimResponse = { token, teamId: 'team-1' };
        await mountRoute();
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith(teamReturn()));
        expect(JSON.parse(String(claimCalls()[0]?.[1]?.body))).toEqual({ code: 'mtls-code', admissionReference: 'mtls-admission-1' });
        expect(login).toHaveBeenCalledWith({ token }, { target: { serverId: home.id, serverUrl: home.serverUrl } });
        expect(clearCustody).toHaveBeenCalledWith({ serverId: home.id, serverUrl: home.serverUrl });
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token });
        expect((await TokenStorage.readPendingExternalAuthContinuationState()).value).toBeNull();
    });
    it('retains an existing-Account invitation continuation for the canonical explicit Join', async () => {
        const pending = await seedPending(true);
        const invitation = { v: 1, kind: 'post_auth_invitation', reference: 'mtls_claim_mtls-admission-1', teamId: 'team-1' };
        claimResponse = { token, teamId: 'team-1', teamInvitationContinuation: invitation };
        const clear = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
        await mountRoute();
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith(teamReturn() + '&postAuthInvitation=1'));
        expect(clear).not.toHaveBeenCalled();
        expect(login).toHaveBeenCalledWith({ token }, { target: { serverId: home.id, serverUrl: home.serverUrl } });
        expect((await TokenStorage.readPendingExternalAuthContinuationState()).value).toEqual({ ...pending, postAuthInvitation: invitation });
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token });
    });
    it('rejects a callback whose Team admission reference does not match pending custody', async () => {
        await seedPending(true);
        boundary.params.admissionReference = 'mtls-admission-other';
        await mountRoute();
        await assertRefused(teamReturn());
        expect(claimCalls()).toHaveLength(0);
    });
    it.each(['wrong Team', 'missing token', 'mismatched invitation continuation'])('fails %s through the exact Team recovery path', async (failure) => {
        await seedPending(true);
        claimResponse = failure === 'missing token' ? { teamId: 'team-1' }
            : failure === 'wrong Team' ? { token, teamId: 'team-other' }
                : { token, teamId: 'team-1', teamInvitationContinuation: {
                    v: 1, kind: 'post_auth_invitation', reference: 'mtls_claim_mtls-admission-1', teamId: 'team-other',
                } };
        await mountRoute();
        await assertRefused(teamReturn());
        expect(claimCalls()).toHaveLength(1);
    });
    it('fails a replayed continuation before claim and returns to the exact Team', async () => {
        await seedPending(true);
        // Another browser actor removes custody after capture. Real currentness remains live.
        let retired = false;
        browser.getItemMock.mockImplementation((key) => {
            const raw = browser.store.get(key) ?? null;
            if (!retired && raw?.includes('"admissionReference":"mtls-admission-1"')) {
                retired = true;
                for (const [storedKey, value] of browser.store) if (value === raw) browser.store.delete(storedKey);
            }
            return raw;
        });
        await mountRoute();
        await assertRefused(teamReturn());
        expect(retired).toBe(true);
        expect(claimCalls()).toHaveLength(0);
    });
    it('does not navigate as a successful mTLS replacement when credential recovery fails', async () => {
        const stored = { token };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, stored)).toBe(true);
        const seed = new Uint8Array(32).fill(7);
        const secret = encodeBase64(seed, 'base64url');
        const binding = await buildContentKeyBinding(seed);
        // Retained request is schema/binding-valid. Failure occurs at the HTTP challenge,
        // before its migration payload or signature can be submitted.
        const migration = AccountEncryptionMigrateRequestSchema.parse({ toMode: 'e2ee', expectedAccountVersion: 8,
            expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null, expectedSettingsVersion: 3,
            settingsContent: { t: 'encrypted', c: 'ciphertext' }, connectedServices: { action: 'assert_empty' },
            automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' },
            artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' }, reviewComments: { action: 'assert_empty' },
            sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
            keyProof: { v: 1, publicKey: encodeBase64(deriveAccountSigningPublicKey(seed)), ...binding, signature: 'request-signature' },
        });
        const target = { serverId: home.id, serverUrl: home.serverUrl };
        const pending: PendingExternalAuth = { ...await seedPending(), secret, accountEncryptionFirstKey: {
            accountId: 'account-home', requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: migration,
                accountId: 'account-home', sourceMode: 'plain' }), requestJson: JSON.stringify(migration),
            createdAt: Date.now(), expiresAt: Date.now() + 60_000, pending: 'pending-first-key', migrationSubmissionAttempted: true,
        } };
        expect(await TokenStorage.setPendingExternalAuth(pending, target)).toBe(true);
        const guarded = await guardAccountEncryptionFirstKeyCredentialMutation(target);
        if (guarded.kind !== 'finish_encryption_setup') throw new Error('Expected real marked first-key custody');
        const marked = await markAccountEncryptionFirstKeyRejectedCredential({ recovery: guarded.recovery, token: stored.token });
        if (marked.kind !== 'recorded') throw new Error('Expected durable rejected-credential mark');
        expect(await TokenStorage.isPendingExternalAuthContinuationCurrent(marked.recovery.pending)).toBe(true);
        const clear = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
        failRecovery = true;
        claimResponse = { token: 'replacement-token' };
        await mountRoute();
        await vi.waitFor(() => expect(login).toHaveBeenCalled());
        await expect(login.mock.results[0]?.value).resolves.toMatchObject({ kind: 'finish_encryption_setup' });
        expect(Modal.alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
        const modal = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        const finish = modal?.props?.finish;
        if (typeof finish !== 'function' || !modal?.onRequestClose) throw new Error('Expected real recovery presentation');
        expect(await finish()).toEqual({ kind: 'recovery_failed' });
        expect(request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/auth/challenge')).toBe(true);
        modal.onRequestClose();
        await act(async () => {});
        expect(clear).not.toHaveBeenCalled();
        expect(login).toHaveBeenCalledWith({ token: 'replacement-token' }, { target });
        expect(boundary.replace).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
        expect((await TokenStorage.readPendingExternalAuthContinuationState()).value).toEqual(marked.recovery.pending);
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(stored);
    });
});

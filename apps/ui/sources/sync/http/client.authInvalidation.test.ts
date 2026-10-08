import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The real Sync lifecycle also reaches browser record storage; replace only IndexedDB.
import 'fake-indexeddb/auto';
import { ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDeferred } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance, type HomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { subscribeAuthCredentialsInvalidation, type AuthCredentialsInvalidationEvent } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installTokenStorageWebPlatformMocks();
await initializeRealAppRuntimeForTests();

const rejectedToken = createAccountTokenForTests('auth-account');
// Renewed credentials retain the same Account while changing the opaque bearer.
const replacementToken = rejectedToken.replace(/\.signature$/, '.signature-refreshed');
let storageBoundary: ReturnType<typeof installLocalStorageMock>;
let locksBoundary: ReturnType<typeof installWebLockManagerMock>;
let unsubscribe: () => void;
const events: AuthCredentialsInvalidationEvent[] = [];
let preparedHomeHarness: HomeGovernanceHarness | null = null;

beforeEach(async () => {
    storageBoundary = installLocalStorageMock();
    locksBoundary = installWebLockManagerMock();
    await upsertAndActivateServer({ serverUrl: 'http://localhost:3012', name: 'Authentication Home' });
    events.length = 0;
    unsubscribe = subscribeAuthCredentialsInvalidation((event) => { events.push(event); });
});

afterEach(async () => {
    await preparedHomeHarness?.reset();
    preparedHomeHarness = null;
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    unsubscribe();
    resetRuntimeFetch();
    locksBoundary.restore();
    storageBoundary.restore();
    vi.restoreAllMocks();
});

function installRejectedBearerBoundary(onRequest?: (init?: RequestInit) => Promise<Response>) {
    const requests: RequestInit[] = [];
    setRuntimeFetch(async (input, init) => {
        if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
        // Fetch consumes these bytes now; a retry may mutate its shared Headers later.
        requests.push({ ...init, headers: new Headers(init?.headers) });
        return onRequest ? await onRequest(init) : new Response(null, { status: 401 });
    });
    return requests;
}

async function restorePreparedSocketHome() {
    const harness = createHomeGovernanceHarness();
    preparedHomeHarness = harness;
    installHomeGovernanceBoundaries(harness);
    const serverUrl = 'http://localhost:3012';
    const serverId = await harness.addHome({
        name: 'Authentication Home', serverUrl, accountId: 'auth-account',
        credentials: { token: rejectedToken },
    });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: rejectedToken });
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    return { harness, serverId, serverUrl, apiSocket };
}

describe('serverFetch auth invalidation', () => {
    it('retains marked first-key custody and credential bytes without retrying the rejected bearer', async () => {
        const { serverId, serverUrl } = getActiveServerSnapshot();
        const createdAt = Date.now();
        const markedCustody = {
            provider: 'github', proof: 'proof-a', secret: 'secret-a', serverId, serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'auth-account', requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}', pending: 'pending-a', createdAt,
                expiresAt: createdAt + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, migrationSubmissionAttempted: true as const,
            },
        };
        expect(await TokenStorage.setCredentials({ token: rejectedToken, secret: 'secret-a' })).toBe(true);
        expect(await TokenStorage.setPendingExternalAuth(markedCustody)).toBe(true);
        const requests = installRejectedBearerBoundary(async (init) => new Response(null, {
            status: new Headers(init?.headers).get('authorization') === `Bearer ${replacementToken}` ? 200 : 401,
        }));
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/machines')).status).toBe(401);
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toEqual({ token: rejectedToken, secret: 'secret-a' });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'first_key_recovery_required', serverId, serverUrl,
            recovery: { pending: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true,
                rejectedCredentialTokenDigest: expect.any(String) } } } });
        const { peekServerReachabilityToken } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        expect(peekServerReachabilityToken(serverUrl, null)).toBeNull();

        expect((await serverFetch('/v1/machines')).status).toBe(401);
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        expect(requests).toHaveLength(3);
        expect(new Headers(requests[0]?.headers).get('authorization')).toBe(`Bearer ${rejectedToken}`);
        expect(new Headers(requests[1]?.headers).get('authorization')).toBeNull();
        expect(new Headers(requests[2]?.headers).get('authorization')).toBeNull();
        expect(events).toHaveLength(1);

        expect(await TokenStorage.setCredentials({ token: replacementToken, secret: 'secret-a' })).toBe(true);
        expect((await serverFetch('/v1/machines')).status).toBe(200);
        expect((await serverFetch('/v1/machines', { method: 'POST', headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false, retry: 'none' })).status).toBe(401);
        expect((await serverFetch('/v1/machines', undefined, { retry: 'none' })).status).toBe(200);
        expect(new Headers(requests[3]?.headers).get('authorization')).toBe(`Bearer ${replacementToken}`);
        expect(new Headers(requests[5]?.headers).get('authorization')).toBe(`Bearer ${replacementToken}`);
        expect(events).toHaveLength(1);
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toEqual({ token: replacementToken, secret: 'secret-a' });
    });

    it('invalidates stored credentials when the server returns 401 for an authenticated request', async () => {
        await TokenStorage.setCredentials({ token: rejectedToken });
        const requests = installRejectedBearerBoundary();
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/machines')).status).toBe(401);
        const { serverId, serverUrl } = getActiveServerSnapshot();
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toBeNull();
        expect(requests).toHaveLength(1);
        expect(events).toMatchObject([{ kind: 'credentials_removed', serverId, serverUrl }]);
    });

    it('invalidates stored credentials when includeAuth=false but an Authorization header is present', async () => {
        await TokenStorage.setCredentials({ token: rejectedToken });
        installRejectedBearerBoundary();
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        const { serverId, serverUrl } = getActiveServerSnapshot();
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toBeNull();
        expect(events).toMatchObject([{ kind: 'credentials_removed', serverId, serverUrl }]);
    });

    it('retries idempotent requests once with a refreshed credential without invalidating its replacement', async () => {
        await TokenStorage.setCredentials({ token: rejectedToken });
        let requestCount = 0;
        const requests = installRejectedBearerBoundary(async () => {
            if (++requestCount === 1) {
                // A response arrives after another sign-in has published its real
                // credential; conditional invalidation must retain that replacement.
                await TokenStorage.setCredentials({ token: replacementToken });
                return new Response(null, { status: 401 });
            }
            return new Response(null, { status: 200 });
        });
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/account/profile', { method: 'GET', headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(200);
        expect(requests).toHaveLength(2);
        expect(new Headers(requests[0]?.headers).get('authorization')).toBe(`Bearer ${rejectedToken}`);
        expect(new Headers(requests[1]?.headers).get('authorization')).toBe(`Bearer ${replacementToken}`);
        expect(await TokenStorage.getCredentials()).toEqual({ token: replacementToken });
        expect(events).toHaveLength(0);
    });

    it('emits an auth-credential invalidation notification when a bearer token is rejected', async () => {
        await TokenStorage.setCredentials({ token: rejectedToken });
        installRejectedBearerBoundary();
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        const { serverId, serverUrl } = getActiveServerSnapshot();
        expect(events).toMatchObject([{ kind: 'credentials_removed', serverId, serverUrl }]);
    });

    it('does not emit an auth-credential invalidation notification when the stored credentials were not invalidated', async () => {
        await TokenStorage.setCredentials({ token: replacementToken });
        installRejectedBearerBoundary();
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/machines', { method: 'POST', headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        const { serverId, serverUrl } = getActiveServerSnapshot();
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toEqual({ token: replacementToken });
        expect(events).toHaveLength(0);
    });

    it('preserves an empty prepared write 401 after its own rejected credential is retired', async () => {
        const { harness, serverId, serverUrl, apiSocket } = await restorePreparedSocketHome();
        const path = '/v1/account/encryption/migrate';
        harness.answer(serverId, `POST ${path}`, { status: 401, body: { rejectedBody: 'must not escape retired authority' } });

        const response = await apiSocket.request(path, { method: 'POST', body: '{}' }, { retry: 'none' });
        expect(response.status).toBe(401);
        expect(await response.text()).toBe('');
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toBeNull();
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(events).toMatchObject([{ kind: 'credentials_removed', serverId, serverUrl }]);
    });

    it('rejects a prepared write after replacement credentials retire its captured authority', async () => {
        const { harness, serverId, serverUrl, apiSocket } = await restorePreparedSocketHome();
        const path = '/v1/account/encryption/migrate';
        const responseReady = createDeferred<void>();
        harness.answer(serverId, `POST ${path}`, { status: 401, body: { rejectedBody: 'old authority' }, respondAfter: responseReady.promise });
        const pending = apiSocket.request(path, { method: 'POST', body: '{}' }, { retry: 'none' });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'StaleServerGenerationError', retryable: false });
        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).toHaveLength(1));
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token: replacementToken })).toBe(true);
            responseReady.resolve();
            await rejected;
            expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toEqual({ token: replacementToken });
            expect(harness.requestsFor(path)).toHaveLength(1);
            expect(events).toHaveLength(0);
        } finally {
            responseReady.resolve();
        }
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { subscribeAuthCredentialsInvalidation, type AuthCredentialsInvalidationEvent } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installTokenStorageWebPlatformMocks();

const rejectedToken = createAccountTokenForTests('auth-account');
// Renewed credentials retain the same Account while changing the opaque bearer.
const replacementToken = rejectedToken.replace(/\.signature$/, '.signature-refreshed');
let storageBoundary: ReturnType<typeof installLocalStorageMock>;
let locksBoundary: ReturnType<typeof installWebLockManagerMock>;
let unsubscribe: () => void;
const events: AuthCredentialsInvalidationEvent[] = [];

beforeEach(async () => {
    storageBoundary = installLocalStorageMock();
    locksBoundary = installWebLockManagerMock();
    await upsertAndActivateServer({ serverUrl: 'http://localhost:3012', name: 'Authentication Home' });
    events.length = 0;
    unsubscribe = subscribeAuthCredentialsInvalidation((event) => { events.push(event); });
});

afterEach(async () => {
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
        if (new URL(String(input)).pathname === '/v1/auth/ping') return Response.json({});
        requests.push(init ?? {});
        return onRequest ? await onRequest(init) : new Response(null, { status: 401 });
    });
    return requests;
}

describe('serverFetch auth invalidation', () => {
    it('retains marked first-key custody and credential bytes without retrying the rejected bearer', async () => {
        const { serverId, serverUrl } = getActiveServerSnapshot();
        const markedCustody = {
            provider: 'github', proof: 'proof-a', secret: 'secret-a', serverId, serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'auth-account', requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}', pending: 'pending-a', createdAt: Date.now(),
                expiresAt: Number.MAX_SAFE_INTEGER, migrationSubmissionAttempted: true as const,
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
        expect(peekServerReachabilityToken(serverUrl)).toBeNull();

        expect((await serverFetch('/v1/machines')).status).toBe(401);
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        expect(requests).toHaveLength(3);
        expect(new Headers(requests[0]?.headers).get('authorization')).toBe(`Bearer ${rejectedToken}`);
        expect(new Headers(requests[1]?.headers).get('authorization')).toBeNull();
        expect(new Headers(requests[2]?.headers).get('authorization')).toBeNull();
        expect(events).toHaveLength(1);

        expect(await TokenStorage.setCredentials({ token: replacementToken, secret: 'secret-a' })).toBe(true);
        expect((await serverFetch('/v1/machines')).status).toBe(200);
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false, retry: 'none' })).status).toBe(401);
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

    it('retries idempotent requests once with refreshed credentials after invalidating a rejected token', async () => {
        await TokenStorage.setCredentials({ token: rejectedToken });
        let requestCount = 0;
        const requests = installRejectedBearerBoundary(async () => new Response(null, { status: ++requestCount === 1 ? 401 : 200 }));
        // The device credential boundary publishes a concurrently refreshed bearer
        // when the real client re-reads after removing the rejected credential.
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const refreshed = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementationOnce(async (...args) => {
            await TokenStorage.setCredentials({ token: replacementToken });
            return await readCredentials(...args);
        });
        try {
            const { serverFetch } = await import('./client');
            expect((await serverFetch('/v1/account/profile', { method: 'GET', headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(200);
            expect(requests).toHaveLength(2);
            expect(new Headers(requests[1]?.headers).get('authorization')).toBe(`Bearer ${replacementToken}`);
            expect(events).toHaveLength(1);
        } finally { refreshed.mockRestore(); }
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
        expect((await serverFetch('/v1/machines', { headers: { Authorization: `Bearer ${rejectedToken}` } }, { includeAuth: false })).status).toBe(401);
        const { serverId, serverUrl } = getActiveServerSnapshot();
        expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).toEqual({ token: replacementToken });
        expect(events).toHaveLength(0);
    });
});

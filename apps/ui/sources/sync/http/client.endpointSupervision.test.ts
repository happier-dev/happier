import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const token = createAccountTokenForTests('endpoint-account');
beforeEach(async () => {
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'Endpoint Home' });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
});

afterEach(async () => {
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
    vi.useRealTimers();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('serverFetch endpoint supervision', () => {
    it('fails fast without attempting runtimeFetch when the active endpoint supervisor is offline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const client = await import('./client');
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
            if (url.includes('/health') || url.includes('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchMock);

        const { acquireEndpointSupervisor } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const lease = await acquireEndpointSupervisor({
            serverId: getActiveServerSnapshot().serverId,
            endpoint: 'https://api.example.test',
            tokenOverride: token,
        });

        expect(lease.supervisor.getState().phase).toBe('offline');
        const callsBefore = runtimeFetchMock.mock.calls.length;

        const promise = client.serverFetch('/v1/sessions', {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }, { includeAuth: false });
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(5);
        await assertion;

        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsBefore);
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/v1/sessions'))).toBe(false);

        await lease.release({ immediate: true });
        vi.useRealTimers();
    });

    it('reports failures to the endpoint supervisor when runtimeFetch throws during an online phase', async () => {
        const client = await import('./client');
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
            if (url.includes('/health') || url.includes('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            throw new Error(
                'Request failed: https://user:pass@api.example.test/v1/sessions?access_token=secret Authorization: Bearer very-secret-token',
            );
        });
        setRuntimeFetch(runtimeFetchMock);

        const { acquireEndpointSupervisor } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const lease = await acquireEndpointSupervisor({
            serverId: getActiveServerSnapshot().serverId,
            endpoint: 'https://api.example.test',
            tokenOverride: token,
        });

        expect(lease.supervisor.getState().phase).toBe('online');

        await expect(client.serverFetch('/v1/sessions', {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }, { includeAuth: false })).rejects.toThrow(
            'Request failed',
        );

        expect(lease.supervisor.getState().phase).toBe('offline');
        const message = lease.supervisor.getState().lastErrorMessage ?? '';
        expect(message).not.toContain('user:pass');
        expect(message).not.toContain('access_token=secret');
        expect(message).not.toContain('very-secret-token');
        await lease.release({ immediate: true });
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const token = createAccountTokenForTests('endpoint-account');
const replacementToken = createAccountTokenForTests('endpoint-replacement-account');
beforeEach(async () => {
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'Endpoint Home' });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
});

afterEach(async () => {
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
    it('dispatches a canonically ready actual bearer even when the facade credential was rejected', async () => {
        vi.useFakeTimers();
        setRuntimeFetch(async (input, init) => new Response(null, {
            status: String(input).endsWith('/v1/auth/ping') && new Headers(init?.headers).get('Authorization') === `Bearer ${replacementToken}` ? 401 : 200,
        }));
        const { acquireServerReachabilitySupervisor } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { acquireEndpointSupervisor } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const actualHome = await acquireServerReachabilitySupervisor({ serverUrl: 'https://api.example.test', token });
        const endpoint = await acquireEndpointSupervisor({ serverId: getActiveServerSnapshot().serverId, endpoint: 'https://api.example.test', tokenOverride: replacementToken });
        expect(endpoint.supervisor.getState().phase).toBe('auth_failed');
        const client = await import('./client');
        const outcome = await client.serverFetch('/v1/sessions', { headers: { Authorization: `Bearer ${token}` } }, { includeAuth: false }).catch((error: unknown) => error);
        await endpoint.release({ immediate: true });
        await actualHome.release();
        expect(outcome).toHaveProperty('status', 200);
    });

    it.each(['before', 'after'] as const)('keeps an actual bearer response scoped when the facade rebinds %s dispatch', async (rebind) => {
        vi.useFakeTimers();
        const domain = createDeferred<Response>();
        setRuntimeFetch(async (input) => String(input).endsWith('/v1/sessions') ? domain.promise : new Response(null, { status: 200 }));
        const { acquireServerReachabilitySupervisor, peekServerReachabilityScope, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { acquireEndpointSupervisor } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const actualHome = await acquireServerReachabilitySupervisor({ serverUrl: 'https://api.example.test', token });
        const key = { serverId: getActiveServerSnapshot().serverId, endpoint: 'https://api.example.test' };
        const firstEndpoint = await acquireEndpointSupervisor({ ...key, tokenOverride: rebind === 'before' ? replacementToken : token });
        const client = await import('./client');
        const request = client.serverFetch('/v1/sessions', { headers: { Authorization: `Bearer ${token}` } }, { includeAuth: false });
        await vi.advanceTimersByTimeAsync(0);
        const secondEndpoint = rebind === 'after' ? await acquireEndpointSupervisor({ ...key, tokenOverride: replacementToken }) : null;
        expect(peekServerReachabilityScope('https://api.example.test', replacementToken)?.generation).toBe(peekServerReachabilityScope('https://api.example.test', token)?.generation);
        domain.resolve(new Response(null, { status: 401 }));
        await expect(request).resolves.toHaveProperty('status', 401);
        await vi.advanceTimersByTimeAsync(0);
        const actualPhase = peekServerReachabilityState('https://api.example.test', token)?.phase;
        const replacementPhase = peekServerReachabilityState('https://api.example.test', replacementToken)?.phase;
        await secondEndpoint?.release({ immediate: true });
        await firstEndpoint.release({ immediate: true });
        await actualHome.release();
        expect(replacementPhase).toBe('online');
        expect(actualPhase).toBe('auth_failed');
    });

    it.each([403, 503])('reports domain HTTP %s through canonical Home without treating authorization as authentication', async (status) => {
        vi.useFakeTimers();
        setRuntimeFetch(async (input) => String(input).endsWith('/v1/sessions')
            ? new Response(null, { status, headers: { 'Retry-After': '2' } })
            : new Response(null, { status: 200 }));
        const { acquireEndpointSupervisor } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const { peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const endpoint = await acquireEndpointSupervisor({ serverId: getActiveServerSnapshot().serverId, endpoint: 'https://api.example.test', tokenOverride: token });
        const client = await import('./client');
        await expect(client.serverFetch('/v1/sessions', { headers: { Authorization: `Bearer ${token}` } }, { includeAuth: false })).resolves.toHaveProperty('status', status);
        await vi.advanceTimersByTimeAsync(0);
        const state = peekServerReachabilityState('https://api.example.test', token);
        const projectedState = endpoint.supervisor.getState();
        await endpoint.release({ immediate: true });
        expect(state?.phase).toBe(status === 403 ? 'online' : 'offline');
        expect(projectedState.phase).toBe(state?.phase);
        if (status === 503) expect(state?.nextRetryAt).toBe(Date.now() + 2000);
    });

    it('keeps the request pending under canonical offline supervision until caller cancellation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

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

        const cancellation = new AbortController();
        let settled = false;
        const promise = client.serverFetch('/v1/sessions', {
            signal: cancellation.signal,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }, { includeAuth: false }).finally(() => { settled = true; });
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'AbortError',
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);
        cancellation.abort();
        await assertion;

        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsBefore);
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/v1/sessions'))).toBe(false);

        await lease.release({ immediate: true });
        vi.useRealTimers();
    });

    it('reports failures to the endpoint supervisor when runtimeFetch throws during an online phase', async () => {
        vi.useFakeTimers();
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
        await vi.advanceTimersByTimeAsync(0);
        const { peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const canonicalState = peekServerReachabilityState('https://api.example.test', token);
        expect(canonicalState?.phase).toBe('offline');
        expect(lease.supervisor.getState().phase).toBe('offline');
        const message = canonicalState?.lastErrorMessage ?? '';
        expect(lease.supervisor.getState().lastErrorMessage).toBe(message);
        expect(message).not.toContain('user:pass');
        expect(message).not.toContain('access_token=secret');
        expect(message).not.toContain('very-secret-token');
        await lease.release({ immediate: true });
    });
});

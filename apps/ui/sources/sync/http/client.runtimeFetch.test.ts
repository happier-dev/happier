import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { peekServerReachabilityScope } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';

afterEach(async () => {
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('serverFetch runtime fetch override', () => {
    it('reads credentials for the captured active Home instead of ambient credentials', async () => {
        await upsertAndActivateServer({ serverUrl: 'https://home-a.example.test', name: 'Captured Home' });
        const token = createAccountTokenForTests('captured-account');
        const ambient = vi.spyOn(TokenStorage, 'getCredentials').mockResolvedValue({ token: createAccountTokenForTests('other-account') });
        const scoped = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const overrideFetch = vi.fn<RuntimeFetch>(async () => new Response(null, { status: 200 }));
        setRuntimeFetch(overrideFetch);
        const { serverFetch } = await import('./client');
        await serverFetch('/v1/features', undefined, { retry: 'none' });
        expect(scoped).toHaveBeenCalledWith('https://home-a.example.test', { serverId: getActiveServerSnapshot().serverId });
        expect(ambient).not.toHaveBeenCalled();
        expect(new Headers(overrideFetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    });

    it('uses the configured runtime fetch implementation instead of global fetch', async () => {
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'Runtime Home' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        const globalFetch = vi.fn(async () => { throw new Error('global fetch should not be called'); });
        vi.stubGlobal('fetch', globalFetch);
        const overrideFetch = vi.fn<RuntimeFetch>(async () => new Response(null, { status: 200 }));
        setRuntimeFetch(overrideFetch);
        const { serverFetch } = await import('./client');
        expect((await serverFetch('/v1/health', undefined, { retry: 'none' })).status).toBe(200);
        expect(overrideFetch.mock.calls.map(([url]) => String(url))).toEqual(['https://api.example.test/v1/health']);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('keys explicitly supervised runtime-origin requests by the stable Home endpoint', async () => {
        const token = createAccountTokenForTests('runtime-origin-account');
        const overrideFetch = vi.fn<RuntimeFetch>(async () => new Response(null, { status: 200 }));
        setRuntimeFetch(overrideFetch);
        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({
            endpointUrl: 'https://home-b.example.test', runtimeOrigin: 'http://127.0.0.1:43210',
            credentials: { token }, superviseReachability: true,
        });
        expect((await request('/v1/example', { method: 'GET' })).status).toBe(200);
        expect(peekServerReachabilityScope('https://home-b.example.test', token)).not.toBeNull();
        expect(peekServerReachabilityScope('http://127.0.0.1:43210', token)).toBeNull();
        expect(overrideFetch.mock.calls.some(([url]) => String(url) === 'http://127.0.0.1:43210/v1/example')).toBe(true);
    });
});

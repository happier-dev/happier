import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { peekServerReachabilityScope, startServerReachabilitySupervisor } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
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
    it.each([302, 307, 308])('scopes credentials and secret-body replay from a captured Home for %i', async (status) => {
        let secondHopRequests = 0;
        let secondHopCredentials = false;
        let secondHopBody = false;
        const server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing listener port');
            if (request.url === '/redirect') {
                response.writeHead(status, { Location: `http://localhost:${address.port}/second-hop?secret=not-for-diagnostics` });
                response.end();
                return;
            }
            if (request.url?.startsWith('/second-hop')) {
                secondHopRequests += 1;
                secondHopCredentials ||= Boolean(request.headers.authorization);
                secondHopBody ||= body.length > 0;
            }
            response.writeHead(200);
            response.end('ok');
        });
        server.listen(0);
        await once(server, 'listening');
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing listener port');
            setRuntimeFetch(globalThis.fetch);
            const { createServerFetchAtEndpoint } = await import('./client');
            const request = createServerFetchAtEndpoint({
                endpointUrl: `http://127.0.0.1:${address.port}`,
                credentials: { token: createAccountTokenForTests('redirect-account') },
            });
            const operation = request('/redirect', {
                method: 'POST', body: 'synthetic-approval-body', redirect: 'follow',
            }, { retry: 'none' });
            if (status === 302) expect((await operation).status).toBe(200);
            else await expect(operation).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
            expect(secondHopRequests).toBe(status === 302 ? 1 : 0);
            expect(secondHopCredentials).toBe(false);
            expect(secondHopBody).toBe(false);
            expect(await (await request('/ordinary', undefined, { retry: 'none' })).text()).toBe('ok');
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

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

    it.each(['http://127.0.0.1:43210', 'https://ingress.example.test'])('admits cold and warm captured requests through %s under the stable Home scope', async (runtimeOrigin) => {
        const token = createAccountTokenForTests('runtime-origin-account');
        const controller = new AbortController();
        const overrideFetch = vi.fn<RuntimeFetch>(async (url) => {
            if (new URL(String(url)).origin !== runtimeOrigin) {
                controller.abort();
                throw new TypeError('Canonical Home has no ingress');
            }
            return new Response(null, { status: 200 });
        });
        setRuntimeFetch(overrideFetch);
        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({
            endpointUrl: 'https://home-b.example.test', runtimeOrigin,
            credentials: { token }, superviseReachability: true,
        });
        // Focus moving after capture must neither reroute nor re-authorize the captured request.
        await upsertAndActivateServer({ serverUrl: 'https://focused-after-capture.example.test', name: 'Focused later' });
        const focused = getActiveServerSnapshot();
        expect((await request('/v1/example', { method: 'GET', signal: controller.signal })).status).toBe(200);
        expect((await request('/v1/example', { method: 'GET', signal: controller.signal })).status).toBe(200);
        expect(peekServerReachabilityScope('https://home-b.example.test', token)).not.toBeNull();
        expect(peekServerReachabilityScope(runtimeOrigin, token)).toBeNull();
        expect(overrideFetch.mock.calls.map(([url]) => String(url))).toEqual([
            `${runtimeOrigin}/v1/auth/ping`, `${runtimeOrigin}/v1/example`, `${runtimeOrigin}/v1/example`,
        ]);
        expect(overrideFetch.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get('Authorization')))
            .toEqual([`Bearer ${token}`, `Bearer ${token}`]);
        expect(getActiveServerSnapshot()).toEqual(focused);
    });

    it('admits a fresh bearer through the already selected native origin without borrowing the old bearer verdict', async () => {
        const serverUrl = 'https://home-b.example.test';
        const runtimeOrigin = 'http://127.0.0.1:43210';
        const oldToken = createAccountTokenForTests('old-native-account');
        const newToken = createAccountTokenForTests('new-native-account');
        const controller = new AbortController();
        const overrideFetch = vi.fn<RuntimeFetch>(async (url) => {
            if (new URL(String(url)).origin !== runtimeOrigin) {
                controller.abort();
                throw new TypeError('Canonical Home has no ingress');
            }
            return new Response(null, { status: 200 });
        });
        setRuntimeFetch(overrideFetch);
        await startServerReachabilitySupervisor({ serverUrl, token: oldToken, runtimeOrigin });
        overrideFetch.mockClear();
        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, runtimeOrigin, credentials: { token: newToken }, superviseReachability: true });
        expect((await request('/v1/example', { signal: controller.signal })).status).toBe(200);
        expect(overrideFetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('Authorization')])).toEqual([
            [`${runtimeOrigin}/v1/auth/ping`, `Bearer ${newToken}`],
            [`${runtimeOrigin}/v1/example`, `Bearer ${newToken}`],
        ]);
        expect(peekServerReachabilityScope(serverUrl, oldToken)).not.toBeNull();
        expect(peekServerReachabilityScope(serverUrl, newToken)).not.toBeNull();
    });

    it.each(['https://home-b.example.test', 'https://other-home.example.test'])('refuses a captured native bearer sent to the wrong origin %s before admission', async (foreignOrigin) => {
        const overrideFetch = vi.fn<RuntimeFetch>(async () => new Response(null, { status: 200 }));
        setRuntimeFetch(overrideFetch);
        const { createServerFetchAtEndpoint } = await import('./client');
        const token = createAccountTokenForTests('native-account');
        const request = createServerFetchAtEndpoint({
            endpointUrl: 'https://home-b.example.test', runtimeOrigin: 'http://127.0.0.1:43210',
            credentials: { token }, superviseReachability: true,
        });
        await expect(request(`${foreignOrigin}/v1/example`)).rejects.toBeInstanceOf(Error);
        expect(overrideFetch).not.toHaveBeenCalled();
        expect(peekServerReachabilityScope('https://home-b.example.test', token)).toBeNull();
    });

    it('cancels cold native admission without dispatching that request or cancelling shared readiness', async () => {
        const runtimeOrigin = 'http://127.0.0.1:43210';
        const controller = new AbortController();
        let releaseProbe!: () => void;
        let observeProbe!: () => void;
        const probeAnswer = new Promise<void>(resolve => { releaseProbe = resolve; });
        const probeIssued = new Promise<void>(resolve => { observeProbe = resolve; });
        const overrideFetch = vi.fn<RuntimeFetch>(async (url) => {
            if (String(url) === `${runtimeOrigin}/v1/auth/ping`) {
                observeProbe();
                await probeAnswer;
            }
            return new Response(null, { status: 200 });
        });
        setRuntimeFetch(overrideFetch);
        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({
            endpointUrl: 'https://home-b.example.test', runtimeOrigin,
            credentials: { token: createAccountTokenForTests('native-account') }, superviseReachability: true,
        });
        const cancelled = request('/v1/cancelled', { signal: controller.signal });
        const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        const shared = request('/v1/shared');
        try {
            await probeIssued;
            controller.abort();
            await rejection;
        } finally {
            releaseProbe();
        }
        expect((await shared).status).toBe(200);
        expect(overrideFetch.mock.calls.map(([url]) => String(url))).toEqual([
            `${runtimeOrigin}/v1/auth/ping`, `${runtimeOrigin}/v1/shared`,
        ]);
    });
});

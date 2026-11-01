import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            get currentState() {
                                return appState.currentState;
                            },
                        },
                    }
    );
});

function okResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
}

function onlineState(): ManagedEndpointSupervisorState {
    return {
        phase: 'online',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    };
}

async function acquireReadyEndpointSupervisor() {
    getCredentialsForServerUrlMock.mockResolvedValue(null);
    runtimeFetchMock.mockResolvedValue(okResponse());
    const { acquireEndpointSupervisor } = await import('./endpointSupervisorPool');
    return await acquireEndpointSupervisor({ serverId: 'server-a', endpoint: 'https://a.example.test', tokenOverride: 'token-1' });
}

describe('createEndpointSupervisedRequest', () => {
    it.each([403, 500, 503])('keeps resource HTTP %s operation-scoped and admits an unrelated request', async (status) => {
        const handle = await acquireReadyEndpointSupervisor();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) =>
            String(input).endsWith('/resource') ? new Response(null, { status }) : okResponse());
        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a', serverUrl: 'https://a.example.test', token: 'token-1', endpointSupervisor: handle.supervisor,
        });
        try {
            expect((await request('/resource', { method: 'GET' })).status).toBe(status);
            expect(handle.supervisor.getState().phase).toBe('online');
            expect((await request('/unrelated', { method: 'POST' })).ok).toBe(true);
        } finally {
            await handle.release({ immediate: true });
        }
    });

    it.each([401, 502, 503, 504])('applies HTTP %s to the real endpoint supervisor and recovers when retryable', async (status) => {
        vi.useFakeTimers();
        const handle = await acquireReadyEndpointSupervisor();
        const { supervisor } = handle;
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) =>
            String(input).endsWith('/v1/sessions') ? new Response(null, { status, headers: status === 503 ? { 'Retry-After': '2' } : {} }) : okResponse());
        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a', serverUrl: 'https://a.example.test', token: 'token-1', endpointSupervisor: supervisor,
        });
        try {
            await request('/v1/sessions', { method: 'GET' });
            expect(supervisor.getState().phase).toBe(status === 401 ? 'auth_failed' : 'offline');
            if (status !== 401) {
                expect(supervisor.getState().nextRetryAt).toBeGreaterThan(Date.now());
                await vi.advanceTimersToNextTimerAsync();
                expect(supervisor.getState().phase).toBe('online');
            }
        } finally {
            await handle.release({ immediate: true });
        }
    });

    it.each([401, 503])('ignores a stale HTTP %s response after a newer probe', async (status) => {
        const handle = await acquireReadyEndpointSupervisor();
        const { supervisor } = handle;
        let respond!: (response: Response) => void;
        let dispatched!: () => void;
        const dispatchedPromise = new Promise<void>((resolve) => { dispatched = resolve; });
        runtimeFetchMock.mockImplementation((input: RequestInfo | URL) => String(input).endsWith('/v1/sessions') ? new Promise<Response>((resolve) => {
            respond = resolve;
            dispatched();
        }) : Promise.resolve(okResponse()));
        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a', serverUrl: 'https://a.example.test', token: 'token-1', endpointSupervisor: supervisor,
        });
        try {
            const pending = request('/v1/sessions', { method: 'GET' });
            await dispatchedPromise;
            supervisor.invalidate();
            await supervisor.waitUntilOnline();
            expect(supervisor.getState().phase).toBe('online');
            respond(new Response(null, { status, headers: status === 503 ? { 'Retry-After': '2' } : {} }));
            await pending;
            expect(supervisor.getState().phase).toBe('online');
        } finally {
            await handle.release({ immediate: true });
        }
    });

    afterEach(async () => {
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        appState.currentState = 'active';
        vi.resetModules();
        vi.useRealTimers();
        try {
            const { resetEndpointSupervisorPoolForTests } = await import('./endpointSupervisorPool');
            await resetEndpointSupervisorPoolForTests();
        } catch {
            // ignore
        }
    });

    it('passes token override to readiness probes when TokenStorage has no credentials', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        runtimeFetchMock.mockResolvedValue(okResponse());

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            token: 'token-1',
        });

        await request('/v1/sessions', { method: 'GET', headers: {} });

        const authPingCall = runtimeFetchMock.mock.calls.find((call) => String(call[0]).includes('/v1/auth/ping'));
        expect(authPingCall).toBeTruthy();
        const init = authPingCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-1');
    });

    it('sanitizes runtime fetch error messages before reporting them to the endpoint supervisor', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
            if (url.includes('/v1/sessions')) {
                throw new Error(
                    'request failed: https://admin:secret@custom.example.test:9443/path/v1/sessions?token=abc (Authorization: Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)',
                );
            }
            return okResponse();
        });

        const reportFailure = vi.fn();
        const reportProbeResult = vi.fn();
        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate: vi.fn(),
            reportFailure,
            reportProbeResult,
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState(),
            subscribe: () => () => {},
        };

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'https://admin:secret@custom.example.test:9443/path',
            token: 'token-1',
            endpointSupervisor: supervisor,
        });

        await expect(request('/v1/sessions', { method: 'GET', headers: {} })).rejects.toThrow(/request failed/i);

        expect(reportFailure).toHaveBeenCalledWith({
            errorMessage: expect.stringContaining('https://custom.example.test:9443/path/v1/sessions'),
        });
        const message = reportFailure.mock.calls[0]?.[0]?.errorMessage as string;
        expect(message).toContain('Bearer [REDACTED]');
        expect(message).not.toContain('admin:secret@');
        expect(message).not.toContain('token=abc');
        expect(message).not.toContain('hdr.eyJ');
    });

    it('reports proxy maintenance 503 responses as planned server restarts', async () => {
        vi.useFakeTimers();
        const handle = await acquireReadyEndpointSupervisor();
        const { supervisor } = handle;
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/v1/sessions') ? new Response('Server reload in progress', {
            status: 503,
            headers: {
                'Retry-After': '2',
                'X-Happier-Retry-Reason': 'server_restarting',
            },
        }) : okResponse());

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            token: 'token-1',
            endpointSupervisor: supervisor,
        });

        try {
            const response = await request('/v1/sessions', { method: 'GET', headers: {} });
            expect(response.status).toBe(503);
            expect(supervisor.getState()).toMatchObject({ phase: 'offline', reason: 'server_restarting' });
            expect(supervisor.getState().nextRetryAt! - Date.now()).toBe(2_000);
        } finally {
            await handle.release({ immediate: true });
        }
    });

    it('does not report unauthenticated 401 responses as endpoint auth failures', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        runtimeFetchMock.mockResolvedValue(new Response('{}', { status: 401, headers: new Headers() }));

        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate: vi.fn(),
            reportFailure: vi.fn(),
            reportProbeResult: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState(),
            subscribe: () => () => {},
        };

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            endpointSupervisor: supervisor,
        });

        const response = await request('/v1/sessions', { method: 'GET', headers: {} });

        expect(response.status).toBe(401);
        expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
        expect(supervisor.invalidate).not.toHaveBeenCalled();
    });

    it('refuses authenticated requests when serverUrl is not a valid absolute http(s) URL', async () => {
        runtimeFetchMock.mockResolvedValue(okResponse());

        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate: vi.fn(),
            reportFailure: vi.fn(),
            reportProbeResult: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState(),
            subscribe: () => () => {},
        };

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'localhost:3000',
            token: 'token-1',
            endpointSupervisor: supervisor,
        });

        await expect(request('/v1/sessions', { method: 'GET', headers: {} })).rejects.toThrow(/Refused authenticated request/i);
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('refuses authenticated requests when serverUrl is not http(s)', async () => {
        runtimeFetchMock.mockImplementation(async () => {
            throw new Error('runtimeFetch should not be called');
        });

        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate: vi.fn(),
            reportFailure: vi.fn(),
            reportProbeResult: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState(),
            subscribe: () => () => {},
        };

        const { createEndpointSupervisedRequest } = await import('./createEndpointSupervisedRequest');
        const request = createEndpointSupervisedRequest({
            serverId: 'server-a',
            serverUrl: 'ws://a.example.test',
            token: 'token-1',
            endpointSupervisor: supervisor,
        });

        await expect(request('/v1/sessions', { method: 'GET', headers: {} })).rejects.toThrow(/http\(s\)/i);
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });
});

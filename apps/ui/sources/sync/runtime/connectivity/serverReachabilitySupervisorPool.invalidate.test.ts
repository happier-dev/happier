import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import {
    invalidateServerReachabilitySupervisor,
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

const socketBoundary = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketBoundary.io }));

function createSocketBoundary() {
    const handlers = new Map<string, (value?: unknown) => void>();
    let dialTimer: ReturnType<typeof setTimeout> | null = null;
    let healthy = false;
    let attempts = 0;
    const dialStartedAt: number[] = [];
    const socket = {
        connected: false,
        active: false,
        on: (event: string, listener: (value?: unknown) => void) => { handlers.set(event, listener); },
        onAny: vi.fn(),
        offAny: vi.fn(),
        emit: vi.fn(),
        removeAllListeners: () => handlers.clear(),
        connect: () => {
            attempts += 1;
            dialStartedAt.push(Date.now());
            socket.active = true;
            dialTimer = setTimeout(() => {
                dialTimer = null;
                socket.active = false;
                socket.connected = healthy;
                handlers.get(healthy ? 'connect' : 'connect_error')?.(healthy ? undefined : new Error('WebSocket blocked'));
            }, 25);
        },
        disconnect: () => {
            if (dialTimer) clearTimeout(dialTimer);
            dialTimer = null;
            const wasActive = socket.active || socket.connected;
            socket.active = false;
            socket.connected = false;
            if (wasActive) handlers.get('disconnect')?.('io client disconnect');
        },
    };
    socketBoundary.io.mockReturnValue(socket);
    return {
        get attempts() { return attempts; },
        dialStartedAt,
        becomeHealthy() { healthy = true; },
        failAgain() {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (wasConnected) handlers.get('disconnect')?.('transport close');
            else handlers.get('connect_error')?.(new Error('WebSocket blocked'));
        },
    };
}

describe('serverReachabilitySupervisorPool (invalidate)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(async () => {
        vi.useRealTimers();
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        socketBoundary.io.mockReset();
    });

    it('keeps healthy HTTP reads and writes admissible during long socket backoff', async () => {
        const endpoint = 'https://socket-http.example.test';
        setActiveServerId(upsertServerProfile({ serverUrl: endpoint }).id);
        const dispatched: string[] = [];
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path.startsWith('/ordinary-')) dispatched.push(path);
            return new Response('{}', { status: 200 });
        });
        const boundary = createSocketBoundary();
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { serverFetch } = await import('@/sync/http/client');
        apiSocket.initialize({ endpoint, token: 'token-1' }, {} as never);
        const requests: Promise<unknown>[] = [];
        try {
            await vi.advanceTimersByTimeAsync(25);
            for (let failure = 1; failure < 6; failure += 1) {
                await vi.advanceTimersToNextTimerAsync();
                await vi.advanceTimersByTimeAsync(25);
            }
            expect(boundary.attempts).toBe(6);
            expect(boundary.dialStartedAt[5] - boundary.dialStartedAt[4]).toBeGreaterThan(boundary.dialStartedAt[4] - boundary.dialStartedAt[3]);
            requests.push(serverFetch('/ordinary-read', { method: 'GET' }, { includeAuth: false }).catch(error => error));
            requests.push(serverFetch('/ordinary-write', { method: 'POST', body: '{}' }, { includeAuth: false }).catch(error => error));
            await vi.advanceTimersByTimeAsync(1);
            expect(dispatched.sort()).toEqual(['/ordinary-read', '/ordinary-write']);
            expect(await Promise.all(requests)).toMatchObject([{ status: 200 }, { status: 200 }]);
            expect(peekServerReachabilityState(endpoint)?.phase).toBe('online');
        } finally {
            boundary.becomeHealthy();
            await invalidateServerReachabilitySupervisor({ serverUrl: endpoint, token: 'token-1' });
            await vi.advanceTimersByTimeAsync(60_000);
            await Promise.allSettled(requests);
            apiSocket.disconnect();
        }
    });

    it('settles failed socket dials, retains retry demand, escalates until socket success, and supports manual reconnect', async () => {
        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        const boundary = createSocketBoundary();
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const endpoint = 'https://socket-retry.example.test';
        let status = '';
        const unsubscribeStatus = apiSocket.onStatusChange((next) => { status = next; });
        apiSocket.initialize({ endpoint, token: 'token-1' }, {} as never);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(status).toBe('connecting');
            await vi.advanceTimersByTimeAsync(25);
            expect(status).not.toBe('connecting');
            expect(peekServerReachabilityState(endpoint)?.phase).toBe('online');

            await vi.advanceTimersByTimeAsync(25);
            boundary.failAgain();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(224);
            expect(boundary.attempts).toBe(1);
            await vi.advanceTimersByTimeAsync(26);
            expect(boundary.attempts).toBe(2);
            expect(boundary.dialStartedAt[1] - boundary.dialStartedAt[0] - 25).toBe(250);
            await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(25);
            expect(boundary.attempts).toBe(3);
            const secondDelay = boundary.dialStartedAt[2] - boundary.dialStartedAt[1] - 25;
            expect(secondDelay).toBeGreaterThan(250);

            boundary.becomeHealthy();
            await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(25);
            expect(status).toBe('connected');
            expect(boundary.attempts).toBe(4);
            expect(boundary.dialStartedAt[3] - boundary.dialStartedAt[2] - 25).toBeGreaterThan(secondDelay);

            boundary.failAgain();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(249);
            expect(boundary.attempts).toBe(4);
            await vi.advanceTimersByTimeAsync(26);
            expect(status).toBe('connected');
            expect(boundary.attempts).toBe(5);
            expect(peekServerReachabilityState(endpoint)?.phase).toBe('online');
            boundary.failAgain();
            apiSocket.disconnect();
            await vi.advanceTimersByTimeAsync(0);
            apiSocket.connect();
            await vi.advanceTimersByTimeAsync(25);
            expect(status).toBe('connected');
        } finally {
            apiSocket.disconnect();
            unsubscribeStatus();
        }
    });

    it('stops socket retry demand while HTTP is offline and redials when HTTP recovers', async () => {
        let httpHealthy = true;
        setRuntimeFetch(async () => new Response('{}', {
            status: httpHealthy ? 200 : 503,
            headers: httpHealthy ? {} : { 'Retry-After': '1' },
        }));
        const boundary = createSocketBoundary();
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const endpoint = 'https://socket-http-gate.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, {} as never);
        try {
            await vi.advanceTimersByTimeAsync(25);
            expect(boundary.attempts).toBe(1);
            httpHealthy = false;
            await invalidateServerReachabilitySupervisor({ serverUrl: endpoint, token: 'token-1' });
            await vi.advanceTimersByTimeAsync(2_000);
            expect(peekServerReachabilityState(endpoint)?.phase).toBe('offline');
            expect(boundary.attempts).toBe(1);
            httpHealthy = true;
            boundary.becomeHealthy();
            await invalidateServerReachabilitySupervisor({ serverUrl: endpoint, token: 'token-1' });
            await vi.advanceTimersByTimeAsync(25);
            expect(boundary.attempts).toBe(2);
        } finally {
            apiSocket.disconnect();
        }
    });

    it('allows callers to force a re-probe after an offline cycle', async () => {
        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchSpy);

        let phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            phases.push(state.phase);
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });
        expect(phases).toContain('offline');

        runtimeFetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        await invalidateServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        expect(phases.at(-1)).toBe('online');
        const healthCalls = runtimeFetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/health'));
        expect(healthCalls.length).toBeGreaterThanOrEqual(2);

        unsubscribe();
    });

    it('allows callers to force a re-probe while the supervisor still thinks the endpoint is online', async () => {
        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchSpy);

        const states: Array<{ phase: string; reason: string | null }> = [];
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            states.push({ phase: state.phase, reason: state.reason });
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });
        expect(states.at(-1)?.phase).toBe('online');

        runtimeFetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(null, {
                    status: 503,
                    headers: new Headers({
                        'Retry-After': '1',
                        'X-Happier-Retry-Reason': 'server_restarting',
                    }),
                });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        await invalidateServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        expect(states.at(-1)).toEqual({ phase: 'offline', reason: 'server_restarting' });
        const healthCalls = runtimeFetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/health'));
        expect(healthCalls).toHaveLength(2);

        unsubscribe();
    });
});

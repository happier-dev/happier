import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { storage } from '@/sync/domains/state/storage';

import { bindEndpointConnectivityStateToRealtimeStore } from './bindManagedConnectionStateToRealtimeStore';

import {
    invalidateAllServerReachabilitySupervisors,
    invalidateServerReachabilitySupervisor,
    peekServerReachabilityState,
    reportServerUnreachable,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    stopServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

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
        storage.getState().resetEndpointConnectivity();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        { status: 200, phase: 'online' },
        { status: 401, phase: 'auth_failed' },
        { status: 503, phase: 'offline' },
    ])('retains Home readiness until the transport-failure probe verdict ($status)', async ({ status, phase }) => {
        const serverUrl = 'https://example.test';
        const token = 'accepted-token';
        let finishProbe: ((response: Response) => void) | undefined;
        let holdProbe = false;
        // The fetch adapter is the network boundary; supervision and classification stay real.
        setRuntimeFetch(async () => holdProbe
            ? new Promise<Response>((resolve) => { finishProbe = resolve; })
            : new Response(null, { status: 200 }));
        const phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState(serverUrl, (state) => {
            phases.push(state.phase);
        }, token);
        const detachStore = bindEndpointConnectivityStateToRealtimeStore({
            subscribe: (listener) => subscribeServerReachabilityState(serverUrl, listener, token),
        });

        await startServerReachabilitySupervisor({ serverUrl, token });
        phases.length = 0;
        holdProbe = true;
        reportServerUnreachable(serverUrl, new Error('transport close'), token);
        await vi.advanceTimersByTimeAsync(0);

        expect(phases).not.toContain('offline');
        expect(phases).toEqual([]);
        expect(storage.getState().endpointStatus).toBe('online');
        expect(finishProbe).toBeDefined();
        finishProbe?.(new Response(null, { status }));
        await vi.advanceTimersByTimeAsync(0);
        expect(peekServerReachabilityState(serverUrl, token)?.phase).toBe(phase);
        if (phase === 'online') {
            expect(phases).not.toContain('offline');
            // A dropped socket still needs the unchanged online verdict to dial again.
            expect(phases).toContain('online');
        }
        detachStore();
        unsubscribe();
    });

    it('keeps a shared supervisor active until its last subscriber is removed', async () => {
        setRuntimeFetch(async () => new Response(null, { status: 200, headers: new Headers() }));
        const serverUrl = 'https://example.test';
        const unsubscribeA = subscribeServerReachabilityState(serverUrl, () => {});
        const unsubscribeB = subscribeServerReachabilityState(`${serverUrl}/`, () => {});

        try {
            await startServerReachabilitySupervisor({ serverUrl, token: null });
            expect(peekServerReachabilityState(serverUrl)?.phase).toBe('online');

            unsubscribeA();
            await stopServerReachabilitySupervisor(serverUrl);
            expect(peekServerReachabilityState(serverUrl)?.phase).toBe('online');

            unsubscribeB();
            await stopServerReachabilitySupervisor(serverUrl);
            expect(peekServerReachabilityState(serverUrl)).toBeNull();
        } finally {
            unsubscribeA();
            unsubscribeB();
        }
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

        await vi.waitFor(() => expect(states.at(-1)).toEqual({ phase: 'offline', reason: 'server_restarting' }));
        const healthCalls = runtimeFetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/health'));
        expect(healthCalls).toHaveLength(2);

        unsubscribe();
    });

    it.each(['connecting', 'online'] as const)('lets a recovery signal replace a probe the Home never answered (%s)', async (startPhase) => {
        const serverUrl = 'https://example.test';
        const token = 'accepted-token';
        let answering = startPhase === 'online';
        const probeSignals: Array<AbortSignal | undefined> = [];
        // The fetch adapter is the network boundary: an unanswered request stays
        // pending until its caller aborts it, as a platform fetch does.
        setRuntimeFetch((_input, init) => {
            probeSignals.push(init?.signal ?? undefined);
            if (answering) return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        });
        const unsubscribe = subscribeServerReachabilityState(serverUrl, () => {}, token);

        void startServerReachabilitySupervisor({ serverUrl, token });
        await vi.advanceTimersByTimeAsync(0);
        expect(peekServerReachabilityState(serverUrl, token)?.phase).toBe(startPhase);

        // The Home stops answering: failure evidence re-probes, and that probe hangs too.
        answering = false;
        reportServerUnreachable(serverUrl, new Error('transport close'), token);
        await vi.advanceTimersByTimeAsync(1_000);
        const unansweredProbes = probeSignals.length;
        expect(unansweredProbes).toBeGreaterThanOrEqual(startPhase === 'online' ? 2 : 1);

        // The Home answers again and the user presses Retry (or returns to the app).
        answering = true;
        void invalidateAllServerReachabilitySupervisors();
        await vi.advanceTimersByTimeAsync(0);

        expect(probeSignals.length).toBeGreaterThan(unansweredProbes);
        expect(peekServerReachabilityState(serverUrl, token)?.phase).toBe('online');
        // Superseded probes are cancelled, not left holding the Home's request slot.
        expect(probeSignals.slice(startPhase === 'online' ? 1 : 0, unansweredProbes).every((signal) => signal?.aborted === true)).toBe(true);
        unsubscribe();
    });
});

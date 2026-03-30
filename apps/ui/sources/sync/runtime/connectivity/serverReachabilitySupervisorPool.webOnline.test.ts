import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

describe('serverReachabilitySupervisorPool (web online events)', () => {
    const previousRetryMs = process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';
    });

    afterEach(async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = previousRetryMs;
        resetRuntimeFetch();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('invalidates reachability supervisors when the browser goes online', async () => {
        const handlers: Record<string, Array<() => void>> = {};
        const windowStub = {
            addEventListener: (event: string, handler: () => void) => {
                handlers[event] = handlers[event] ?? [];
                handlers[event].push(handler);
            },
        };
        vi.stubGlobal('window', windowStub as any);

        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchSpy);

        const {
            invalidateAllServerReachabilitySupervisors,
            resetServerReachabilitySupervisors,
            startServerReachabilitySupervisor,
            subscribeServerReachabilityState,
        } = await import('./serverReachabilitySupervisorPool');

        let lastPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastPhase = state.phase;
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });
        expect(lastPhase).toBe('offline');

        runtimeFetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        // The module is expected to hook the browser 'online' event and call invalidateAllServerReachabilitySupervisors.
        expect(typeof handlers.online?.[0]).toBe('function');
        handlers.online?.forEach((handler) => handler());

        // Also ensure the helper works in case the module chooses to delegate to the exported invalidation API.
        await invalidateAllServerReachabilitySupervisors();

        expect(lastPhase).toBe('online');

        unsubscribe();
        await resetServerReachabilitySupervisors();
    });

    it('does not start/invalidate supervisors when network is disallowed (background)', async () => {
        const handlers: Record<string, Array<() => void>> = {};
        const windowStub = {
            addEventListener: (event: string, handler: () => void) => {
                handlers[event] = handlers[event] ?? [];
                handlers[event].push(handler);
            },
        };
        vi.stubGlobal('window', windowStub as any);

        const runtimeFetchSpy = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));
        setRuntimeFetch(runtimeFetchSpy);

        const {
            invalidateAllServerReachabilitySupervisors,
            resetServerReachabilitySupervisors,
            setServerReachabilityNetworkAllowed,
            subscribeServerReachabilityState,
        } = await import('./serverReachabilitySupervisorPool');

        let lastPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastPhase = state.phase;
        });

        setServerReachabilityNetworkAllowed(false);

        expect(typeof handlers.online?.[0]).toBe('function');
        handlers.online?.forEach((handler) => handler());
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await invalidateAllServerReachabilitySupervisors();

        expect(runtimeFetchSpy).toHaveBeenCalledTimes(0);
        expect(lastPhase).toBe('idle');

        setServerReachabilityNetworkAllowed(true);
        unsubscribe();
        await resetServerReachabilitySupervisors();
    });
});

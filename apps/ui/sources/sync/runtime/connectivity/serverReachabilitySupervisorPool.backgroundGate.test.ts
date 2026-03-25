import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
    startServerReachabilitySupervisor,
    waitForServerReachable,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

describe('serverReachabilitySupervisorPool (background gating)', () => {
    const previousRetryMs = process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_BACKGROUND_RETRY_MS;

    beforeEach(() => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_BACKGROUND_RETRY_MS = '1000';
    });

    afterEach(async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_BACKGROUND_RETRY_MS = previousRetryMs;
        setServerReachabilityNetworkAllowed(true);
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        vi.useRealTimers();
    });

    it('does not start reachability supervision while network is disallowed', async () => {
        const runtimeFetchSpy = vi.fn(async () => {
            throw new Error('runtimeFetch should not be called');
        });
        setRuntimeFetch(runtimeFetchSpy);
        setServerReachabilityNetworkAllowed(false);

        let lastPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastPhase = state.phase;
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        expect(lastPhase).toBe('idle');
        expect(runtimeFetchSpy).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('waitForServerReachable waits for network to be allowed before starting probes', async () => {
        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://example.test/health') {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            throw new Error(`Unexpected probe url: ${url}`);
        });
        setRuntimeFetch(runtimeFetchSpy);
        setServerReachabilityNetworkAllowed(false);

        const waitPromise = waitForServerReachable({
            serverUrl: 'https://example.test',
            token: null,
            timeoutMs: 5000,
        });

        await vi.advanceTimersByTimeAsync(2000);
        expect(runtimeFetchSpy).not.toHaveBeenCalled();

        setServerReachabilityNetworkAllowed(true);
        await vi.advanceTimersByTimeAsync(1);
        await expect(waitPromise).resolves.toBeUndefined();
        expect(runtimeFetchSpy).toHaveBeenCalledWith('https://example.test/health', expect.anything());
    });
});

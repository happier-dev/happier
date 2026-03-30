import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

function delayedResponse(params: Readonly<{ ms: number; response: Response; signal?: AbortSignal }>): Promise<Response> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(params.response), Math.max(0, params.ms));
        const cleanup = () => {
            clearTimeout(timeout);
            params.signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(new Error('Aborted'));
        };
        if (params.signal) {
            if (params.signal.aborted) {
                onAbort();
                return;
            }
            params.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

describe('serverReachabilitySupervisorPool (probe timeouts)', () => {
    const previousProbeTimeout = process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS;

    beforeEach(() => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS = '50';
    });

    afterEach(async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS = previousProbeTimeout;
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        vi.useRealTimers();
    });

    it('does not allow a hung /health probe to block reachability supervision indefinitely', async () => {
        setRuntimeFetch((input, init) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return delayedResponse({
                    ms: 1_000,
                    response: new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
                    signal: init?.signal ?? undefined,
                });
            }
            throw new Error(`Unexpected probe URL: ${url}`);
        });

        let lastPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastPhase = state.phase;
        });

        const startPromise = startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: null,
        });

        let assertionError: unknown = null;
        try {
            await vi.advanceTimersByTimeAsync(60);
            try {
                expect(lastPhase).toBe('offline');
            } catch (error) {
                assertionError = error;
            }
        } finally {
            await vi.advanceTimersByTimeAsync(2_000);
            await startPromise.catch(() => {});
            unsubscribe();
        }

        if (assertionError) {
            throw assertionError;
        }
    });

    it('does not allow a hung authenticated /v1/auth/ping probe to block reachability supervision indefinitely', async () => {
        setRuntimeFetch((input, init) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            if (url.endsWith('/v1/auth/ping')) {
                return delayedResponse({
                    ms: 1_000,
                    response: new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
                    signal: init?.signal ?? undefined,
                });
            }
            throw new Error(`Unexpected probe URL: ${url}`);
        });

        let lastPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastPhase = state.phase;
        });

        const startPromise = startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'token',
        });

        let assertionError: unknown = null;
        try {
            await vi.advanceTimersByTimeAsync(60);
            try {
                expect(lastPhase).toBe('offline');
            } catch (error) {
                assertionError = error;
            }
        } finally {
            await vi.advanceTimersByTimeAsync(2_000);
            await startPromise.catch(() => {});
            unsubscribe();
        }

        if (assertionError) {
            throw assertionError;
        }
    });
});

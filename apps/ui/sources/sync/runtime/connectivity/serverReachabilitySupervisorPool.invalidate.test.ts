import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    invalidateServerReachabilitySupervisor,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
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
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
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
});

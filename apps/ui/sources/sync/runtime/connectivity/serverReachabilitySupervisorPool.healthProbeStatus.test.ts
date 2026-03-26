import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

afterEach(async () => {
    resetRuntimeFetch();
    await resetServerReachabilitySupervisors();
    vi.useRealTimers();
});

describe('serverReachabilitySupervisorPool (health probe status)', () => {
    it('treats a non-ok /health response as unreachable (prevents wrong-server loops)', async () => {
        vi.useFakeTimers();

        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
            }
            if (url.endsWith('/v1/auth/ping')) {
                throw new Error('Unexpected /v1/auth/ping probe call');
            }
            throw new Error(`Unexpected probe URL: ${url}`);
        });

        setRuntimeFetch(runtimeFetchSpy);

        let lastStatePhase: string | null = null;
        let lastStateReason: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastStatePhase = state.phase;
            lastStateReason = state.reason;
        });

        try {
            await startServerReachabilitySupervisor({
                serverUrl: 'https://example.test',
                token: 'token',
            });
        } finally {
            unsubscribe();
        }

        expect(lastStatePhase).toBe('offline');
        expect(lastStateReason).toBe('server_unreachable');
        expect(runtimeFetchSpy.mock.calls.map(([input]) => String(input))).toEqual(['https://example.test/health']);
    });

    it('treats a 429 /health response as retry_later (respects Retry-After)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response('rate limited', {
                    status: 429,
                    headers: { 'Retry-After': '1' },
                });
            }
            if (url.endsWith('/v1/auth/ping')) {
                throw new Error('Unexpected /v1/auth/ping probe call');
            }
            throw new Error(`Unexpected probe URL: ${url}`);
        });

        setRuntimeFetch(runtimeFetchSpy);

        let lastStatePhase: string | null = null;
        let lastStateReason: string | null = null;
        let lastNextRetryAt: number | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
            lastStatePhase = state.phase;
            lastStateReason = state.reason;
            lastNextRetryAt = state.nextRetryAt;
        });

        try {
            await startServerReachabilitySupervisor({
                serverUrl: 'https://example.test',
                token: 'token',
            });
        } finally {
            unsubscribe();
        }

        expect(lastStatePhase).toBe('offline');
        expect(lastStateReason).toBe('probe_failed');
        expect(lastNextRetryAt).toBe(1000);
        expect(runtimeFetchSpy.mock.calls.map(([input]) => String(input))).toEqual(['https://example.test/health']);
    });
});

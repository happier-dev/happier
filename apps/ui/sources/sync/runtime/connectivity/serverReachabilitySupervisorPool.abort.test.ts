import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    waitForServerReachable,
    peekServerReachabilityState,
    reportServerUnreachable,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

describe('serverReachabilitySupervisorPool (abort semantics)', () => {
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

    it('rejects waitForServerReachable with an AbortError when aborted', async () => {
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        const abortController = new AbortController();
        const waitPromise = waitForServerReachable({
            serverUrl: 'https://example.test',
            token: null,
            signal: abortController.signal,
            timeoutMs: 50_000,
        });

        abortController.abort();

        await expect(waitPromise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not turn caller cancellation into a Home outage', async () => {
        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        reportServerUnreachable('https://example.test', new DOMException('Cancelled', 'AbortError'), null);

        expect(peekServerReachabilityState('https://example.test', null)?.phase).toBe('online');
    });

    it('cancels one waiter while a slow shared probe continues for another waiter', async () => {
        let answer: (response: Response) => void = () => {};
        setRuntimeFetch(() => new Promise<Response>(resolve => { answer = resolve; }));
        const cancellation = new AbortController();
        let cancelled = false;
        const first = waitForServerReachable({
            serverUrl: 'https://example.test', token: null, signal: cancellation.signal,
        }).catch(error => { cancelled = error instanceof Error && error.name === 'AbortError'; });
        const second = waitForServerReachable({ serverUrl: 'https://example.test', token: null });
        void second.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        cancellation.abort();
        await vi.advanceTimersByTimeAsync(0);
        const cancelledBeforeAnswer = cancelled;
        answer(new Response(null, { status: 200 }));
        await vi.advanceTimersByTimeAsync(0);
        await first;
        await second;
        expect(cancelledBeforeAnswer).toBe(true);
        expect(peekServerReachabilityState('https://example.test', null)?.phase).toBe('online');
    });

    it('cancels a cold supervised fetch before shared readiness answers without issuing its request', async () => {
        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        let answer: (response: Response) => void = () => {};
        const requested: string[] = [];
        setRuntimeFetch(input => {
            requested.push(String(input));
            return new Promise<Response>(resolve => { answer = resolve; });
        });
        const cancellation = new AbortController();
        let cancelled = false;
        const fetch = runtimeFetchWithServerReachability({
            serverUrl: 'https://example.test', token: null, url: 'https://example.test/v1/features',
            init: { signal: cancellation.signal },
        }).catch(error => { cancelled = error instanceof Error && error.name === 'AbortError'; });
        const continuing = waitForServerReachable({ serverUrl: 'https://example.test', token: null });
        await vi.advanceTimersByTimeAsync(0);
        cancellation.abort();
        await vi.advanceTimersByTimeAsync(0);
        const cancelledBeforeAnswer = cancelled;
        answer(new Response(null, { status: 200 }));
        await vi.advanceTimersByTimeAsync(0);
        await fetch;
        await continuing;
        expect(cancelledBeforeAnswer).toBe(true);
        expect(requested).not.toContain('https://example.test/v1/features');
    });

    it('does not turn a pre-dispatch callback error into network-failure evidence', async () => {
        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        const unsubscribe = subscribeServerReachabilityState('https://example.test', () => {}, null);
        const callbackError = new Error('Local dispatch callback failed');
        try {
            await expect(runtimeFetchWithServerReachability({
                serverUrl: 'https://example.test', token: null, url: 'https://example.test/v1/features',
                init: {}, onIssued: () => { throw callbackError; },
            })).rejects.toBe(callbackError);
            expect(peekServerReachabilityState('https://example.test', null)?.phase).toBe('online');
        } finally {
            unsubscribe();
        }
    });
});

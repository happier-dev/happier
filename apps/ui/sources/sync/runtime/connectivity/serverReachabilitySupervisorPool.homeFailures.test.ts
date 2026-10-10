import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    dismissHomeReachNudge,
    readHomeReachNudge,
    readRecentHomeReachFailures,
    recordFailedHomeReach,
    subscribeHomeReachNudge,
} from './homeReachFailures';
import {
    peekServerReachabilityState,
    invalidateServerReachabilitySupervisor,
    resetServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
    stopServerReachabilitySupervisors,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';

describe('failed foreground Home reach episodes', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
        getPersistenceStorage().delete('home-reach-failures-v2');
        getPersistenceStorage().delete('home-reach-nudge-dismissed-v1');
        setRuntimeFetch(async () => { throw new TypeError('Network request failed'); });
    });

    afterEach(async () => {
        setServerReachabilityNetworkAllowed(true);
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        getPersistenceStorage().delete('home-reach-failures-v2');
        getPersistenceStorage().delete('home-reach-nudge-dismissed-v1');
        vi.useRealTimers();
    });

    it('records one outage across concurrent and sequential waits, and counts again only after recovery', async () => {
        const now = Date.now();
        const wait = () => waitForServerReachable({
            serverUrl: 'https://home.example.test',
            token: null,
            homeIdentityId: 'srv_home_a',
            timeoutMs: 1000,
        });
        const first = expect(wait()).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        const overlapping = expect(wait()).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(1001);
        await first;
        await overlapping;
        expect(readRecentHomeReachFailures('srv_home_a', now + 1001)).toBe(1);
        expect(readRecentHomeReachFailures('srv_home_b', now + 1001)).toBe(0);

        const later = expect(wait()).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(1001);
        await later;
        expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(1);

        // Restarting the supervisor without reaching online is still the same outage.
        await invalidateServerReachabilitySupervisor({ serverUrl: 'https://home.example.test', token: null });
        const restarted = expect(wait()).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(1001);
        await restarted;
        expect(readHomeReachNudge('srv_home_a', Date.now())).toEqual({ show: false, failureCount: 1 });

        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        await invalidateServerReachabilitySupervisor({ serverUrl: 'https://home.example.test', token: null });
        await wait();
        expect(peekServerReachabilityState('https://home.example.test')?.phase).toBe('online');

        setRuntimeFetch(async () => { throw new TypeError('Network request failed'); });
        await vi.advanceTimersByTimeAsync(251);
        await invalidateServerReachabilitySupervisor({ serverUrl: 'https://home.example.test', token: null });
        const nextOutage = expect(wait()).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(1001);
        await nextOutage;
        expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(2);
        expect(readRecentHomeReachFailures('srv_home_a', Date.now() + 7 * 24 * 60 * 60 * 1000)).toBe(0);
    });

    it('does not count cancellation or a wait gated while backgrounded', async () => {
        const aborted = new AbortController();
        const wait = expect(waitForServerReachable({
            serverUrl: 'https://home.example.test',
            token: null,
            homeIdentityId: 'srv_home_a',
            signal: aborted.signal,
            timeoutMs: 1000,
        })).rejects.toMatchObject({ name: 'AbortError' });
        aborted.abort();
        await wait;

        setServerReachabilityNetworkAllowed(false);
        const gated = expect(waitForServerReachable({
            serverUrl: 'https://home.example.test',
            token: null,
            homeIdentityId: 'srv_home_a',
            timeoutMs: 1000,
        })).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(1001);
        await gated;
        expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(0);
    });

    it('records an actual foreground outage without requiring a waiter deadline', async () => {
        const cancellation = new AbortController();
        const wait = expect(waitForServerReachable({
            serverUrl: 'https://home.example.test', token: null, homeIdentityId: 'srv_home_a', signal: cancellation.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        const failuresBeforeCancellation = readRecentHomeReachFailures('srv_home_a', Date.now());
        cancellation.abort();
        await wait;
        expect(failuresBeforeCancellation).toBe(1);
    });

    it('does not count an expired caller wait after supervision intentionally stops', async () => {
        let finishProbe!: (response: Response) => void;
        setRuntimeFetch(() => new Promise<Response>((resolve) => { finishProbe = resolve; }));
        const wait = expect(waitForServerReachable({
            serverUrl: 'https://home.example.test', token: null, homeIdentityId: 'srv_home_a', timeoutMs: 1000,
        })).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
        await vi.advanceTimersByTimeAsync(0);
        expect(peekServerReachabilityState('https://home.example.test')?.phase).not.toBe('offline');
        await stopServerReachabilitySupervisors();
        expect(peekServerReachabilityState('https://home.example.test')?.phase).toBe('shutting_down');
        finishProbe(new Response(null, { status: 200 }));
        await vi.advanceTimersByTimeAsync(1001);
        await wait;
        expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(0);
    });

    it('prunes expired failures for every Home when recording a new failure', () => {
        const now = Date.now();
        recordFailedHomeReach('srv_home_b', now - 7 * 24 * 60 * 60 * 1000 - 1);
        recordFailedHomeReach('srv_home_a', now);

        expect(JSON.parse(getPersistenceStorage().getString('home-reach-failures-v2') ?? 'null'))
            .toEqual({ srv_home_a: [{ day: Math.floor(now / 86_400_000), count: 1 }] });
    });

    it('bounds each Home to the current seven UTC day-buckets', () => {
        const now = Date.now();
        for (let day = 0; day < 9; day += 1) {
            recordFailedHomeReach('srv_home_a', now + day * 86_400_000);
        }
        expect(JSON.parse(getPersistenceStorage().getString('home-reach-failures-v2') ?? 'null').srv_home_a)
            .toHaveLength(7);
        expect(readRecentHomeReachFailures('srv_home_a', now + 8 * 86_400_000)).toBe(7);
    });

    it('does not treat rejected credentials as a failed reach to the Home', async () => {
        setRuntimeFetch(async () => new Response(null, { status: 401, headers: new Headers() }));
        const wait = expect(waitForServerReachable({
            serverUrl: 'https://home.example.test',
            token: 'rejected-token',
            homeIdentityId: 'srv_home_a',
            timeoutMs: 1000,
        })).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });

        await vi.advanceTimersByTimeAsync(1001);
        await wait;
        expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(0);
    });

    it('keeps seven day-buckets per Home and dismisses the nudge permanently on this device', () => {
        const now = Date.now();
        const seen: number[] = [];
        const unsubscribe = subscribeHomeReachNudge(() => seen.push(readRecentHomeReachFailures('srv_home_a', now)));
        recordFailedHomeReach('srv_home_a', now);
        recordFailedHomeReach('srv_home_a', now + 1);
        expect(readHomeReachNudge('srv_home_a', now + 1)).toEqual({ show: false, failureCount: 2 });
        recordFailedHomeReach('srv_home_a', now + 2);
        expect(readHomeReachNudge('srv_home_a', now + 2)).toEqual({ show: true, failureCount: 3 });
        expect(seen).toEqual([1, 2, 3]);
        dismissHomeReachNudge('srv_home_a');
        expect(readHomeReachNudge('srv_home_a', now + 2)).toEqual({ show: false, failureCount: 3 });
        recordFailedHomeReach('srv_home_a', now + 8 * 86_400_000);
        recordFailedHomeReach('srv_home_a', now + 8 * 86_400_000 + 1);
        recordFailedHomeReach('srv_home_a', now + 8 * 86_400_000 + 2);
        expect(readHomeReachNudge('srv_home_a', now + 8 * 86_400_000 + 2))
            .toEqual({ show: false, failureCount: 3 });
        expect(JSON.parse(getPersistenceStorage().getString('home-reach-failures-v2') ?? 'null').srv_home_a)
            .toHaveLength(1);
        unsubscribe();
    });

    it('does not record a Home miss while the web device reports offline', async () => {
        vi.stubGlobal('navigator', { onLine: false });
        try {
            const wait = expect(waitForServerReachable({
                serverUrl: 'https://home.example.test', token: null, homeIdentityId: 'srv_home_a', timeoutMs: 1000,
            })).rejects.toMatchObject({ name: 'ServerReachabilityWaitTimeoutError' });
            await vi.advanceTimersByTimeAsync(1001);
            await wait;
            expect(readRecentHomeReachFailures('srv_home_a', Date.now())).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

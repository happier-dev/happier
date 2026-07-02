import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup, type Deferred } from '@/dev/testkit';

import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationLoadResult,
    type UseTranscriptOlderPaginationInput,
} from './useTranscriptOlderPagination';

type HarnessOverrides = Partial<Omit<UseTranscriptOlderPaginationInput, 'loadOlder'>>;

function createHarness(overrides?: HarnessOverrides) {
    const pendingLoads: Deferred<TranscriptOlderPaginationLoadResult | null>[] = [];
    const loadOlder = vi.fn(() => {
        const deferred = createDeferred<TranscriptOlderPaginationLoadResult | null>();
        pendingLoads.push(deferred);
        return deferred.promise;
    });
    const input: UseTranscriptOlderPaginationInput = {
        enabled: true,
        loadOlder,
        thresholdPx: 400,
        cooldownMs: 500,
        spinnerDelayMs: 200,
        isFillDone: () => true,
        isTransactionOpen: () => false,
        ...overrides,
    };
    return { input, loadOlder, pendingLoads };
}

async function observe(
    hook: { getCurrent: () => ReturnType<typeof useTranscriptOlderPagination> },
    metrics: { offsetY: number; scrollable?: boolean },
) {
    await act(async () => {
        hook.getCurrent().onScrollObservation({ offsetY: metrics.offsetY, scrollable: metrics.scrollable ?? true });
    });
}

async function resolveLoad(
    pendingLoads: Deferred<TranscriptOlderPaginationLoadResult | null>[],
    result: TranscriptOlderPaginationLoadResult | null,
) {
    const deferred = pendingLoads.shift();
    if (!deferred) throw new Error('No pending loadOlder call to resolve');
    await act(async () => {
        deferred.resolve(result);
        await Promise.resolve();
    });
}

describe('useTranscriptOlderPagination', () => {
    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('starts exactly one load on threshold ENTER and keeps a single load in flight', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(loadOlder).toHaveBeenCalledWith({ trigger: 'threshold-enter' });

        await observe(hook, { offsetY: 90 });
        await observe(hook, { offsetY: 60 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().hasMore).toBe(true);
    });

    it('delays the loading indicator by spinnerDelayMs and clears it when the load settles', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness({ spinnerDelayMs: 200 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(199);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('never shows the loading indicator when the load settles before spinnerDelayMs', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness({ spinnerDelayMs: 200 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('requires threshold EXIT then ENTER (plus cooldown) before the next load', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        // Still inside the threshold: neither time nor repeat observations may retrigger.
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        await observe(hook, { offsetY: 100 });
        await observe(hook, { offsetY: 80 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('honors the cooldown for an EXIT/ENTER that lands during it, loading at cooldown end', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });

        // Prepend growth pushed the viewport out; the user scrolls back in during cooldown.
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(loadOlder).toHaveBeenLastCalledWith({ trigger: 'post-cooldown' });
    });

    it('suspends loads while a viewport transaction is open and loads once it closes', async () => {
        vi.useFakeTimers();
        let transactionOpen = true;
        const { input, loadOlder } = createHarness({ isTransactionOpen: () => transactionOpen });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();

        transactionOpen = false;
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('suspends loads until the initial fill is done', async () => {
        vi.useFakeTimers();
        let fillDone = false;
        const { input, loadOlder } = createHarness({ isFillDone: () => fillDone });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();

        fillDone = true;
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('suspends loads while the observed offset is <= 0 (negative-offset settling)', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 0 });
        await observe(hook, { offsetY: -30 });
        expect(loadOlder).not.toHaveBeenCalled();

        await observe(hook, { offsetY: 40 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('treats hasMore=false as terminal and exposes it until reset()', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'no_more', loaded: 0, hasMore: false });
        expect(hook.getCurrent().hasMore).toBe(false);

        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 100 });
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().reset();
        });
        expect(hook.getCurrent().hasMore).toBe(true);

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('enters cooldown after a null result without a tight retry loop', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, null);
        expect(hook.getCurrent().hasMore).toBe(true);

        await observe(hook, { offsetY: 100 });
        await observe(hook, { offsetY: 90 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        // Recovery still requires EXIT -> ENTER after the cooldown.
        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 100 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('enters cooldown when loadOlder rejects', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        const deferred = pendingLoads.shift();
        if (!deferred) throw new Error('No pending loadOlder call to reject');
        await act(async () => {
            deferred.reject(new Error('network down'));
            await Promise.resolve();
        });

        expect(hook.getCurrent().hasMore).toBe(true);
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
        await observe(hook, { offsetY: 100 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('ignores observations and never loads while disabled', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness({ enabled: false });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('treats non-scrollable observations as outside the threshold (no optimistic arming)', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120, scrollable: false });
        expect(loadOlder).not.toHaveBeenCalled();

        // The first scrollable observation inside the threshold is an ENTER.
        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('reset() clears the loading indicator and pending timers, and a late settle is inert', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ spinnerDelayMs: 0 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await act(async () => {
            hook.getCurrent().reset();
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
        expect(hook.getCurrent().hasMore).toBe(true);

        // Fresh session state: the next ENTER loads again.
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('cleans up timers on unmount without firing late loads', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });

        await hook.unmount();
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });
});

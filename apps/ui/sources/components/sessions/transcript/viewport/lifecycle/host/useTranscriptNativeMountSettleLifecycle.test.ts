/**
 * Producer contract for the native mount-settle reveal gate.
 *
 * `nativeMountSettleStable` is consumed by the native reveal edge
 * (`resolveNativeFollowBottomObservationCanReleasePaint`) and by
 * `sessionOpenLatch.shouldShowNativeFirstPaintPlaceholder`, but nothing in this package ever set it
 * to `true`: the only writer was `setNativeMountSettleStable(false)` on session arm. A gate whose
 * positive fact has no producer either accepts unconditionally (the pre-port state) or waits out the
 * fallback deadline on every open. This hook is that producer.
 *
 * Mount settle is a native placement fact, not a renderer fact: its inputs (list layout commits and
 * composer inset changes) are produced by the transcript host, identically for whichever list
 * renderer is mounted. The producer is therefore gated on native only.
 *
 * The hang guard below is the load-bearing case: this repository's reveal gate must never be able to
 * withhold content. The deadline path must fire, exactly once, even when stability never arrives.
 */
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { createTranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import { useTranscriptNativeMountSettleLifecycle } from './useTranscriptNativeMountSettleLifecycle';

const MOUNT_SETTLE_QUIESCENT_WINDOW_MS = 120;
const INITIAL_FILL_BUDGET_MS = 2000;
const DEADLINE_MS = INITIAL_FILL_BUDGET_MS + MOUNT_SETTLE_QUIESCENT_WINDOW_MS;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptInitialFillBudgetMs: INITIAL_FILL_BUDGET_MS,
            transcriptMountSettleQuiescentWindowMs: MOUNT_SETTLE_QUIESCENT_WINDOW_MS,
        }),
    },
}));

const SESSION_ID = 'session-a';

function createHarness(overrides?: Readonly<{ platformOS?: string }>) {
    const lifecycleHost = createTranscriptLifecycleHost();
    const setNativeMountSettleStable = vi.fn();
    const setNativeMountSettleDeadlineReached = vi.fn();
    const scheduleNativePaintReleaseForEntryRestore = vi.fn();
    const nativeMountSettleDeadlineReachedRef = { current: false };
    const sampleMountSettle = vi.spyOn(lifecycleHost, 'sampleMountSettle');

    const params = {
        composerInsetHeightRef: { current: 0 },
        jumpToSeqActive: false,
        lastPinOffsetForIntentRef: { current: 0 as number | null },
        lifecycleHost,
        listContentHeightRef: { current: 900 },
        listLayoutHeightRef: { current: 600 },
        nativeMountSettleDeadlineReachedRef,
        platformOS: overrides?.platformOS ?? 'ios',
        scheduleNativePaintReleaseForEntryRestore,
        sessionId: SESSION_ID,
        sessionOpenLatch: createSessionOpenLatch(),
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
    };

    /** Drives the real mount-settle coordinator to a stable settle through its own public API. */
    const reachStableSettle = () => {
        const nowMs = Date.now();
        lifecycleHost.recordMountSettleFirstListPaint({ nowMs, sessionId: SESSION_ID });
        lifecycleHost.recordMountSettleLayoutCommitObserved({ nowMs, sessionId: SESSION_ID });
        lifecycleHost.observeMountSettleMetrics({
            composerInsetHeight: 0,
            distanceFromBottom: 0,
            initialFillStatus: 'done',
            listContentHeight: 900,
            listLayoutHeight: 600,
            nowMs,
            sessionId: SESSION_ID,
        });
    };

    return {
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        params,
        reachStableSettle,
        sampleMountSettle,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
    };
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe('useTranscriptNativeMountSettleLifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('samples mount settle on native and publishes stability when it arrives', async () => {
        const harness = createHarness();
        const hook = await renderHook(() => useTranscriptNativeMountSettleLifecycle(harness.params));

        await advance(MOUNT_SETTLE_QUIESCENT_WINDOW_MS);
        expect(harness.sampleMountSettle).toHaveBeenCalled();

        harness.reachStableSettle();
        await advance(MOUNT_SETTLE_QUIESCENT_WINDOW_MS);

        expect(harness.setNativeMountSettleStable).toHaveBeenCalledWith(true);
        expect(harness.setNativeMountSettleDeadlineReached).not.toHaveBeenCalled();
        expect(harness.nativeMountSettleDeadlineReachedRef.current).toBe(false);

        await hook.unmount();
    });

    // Blank-screen guard. A reveal gate that can be withheld indefinitely is strictly worse than the
    // flicker it prevents, so the producer must reach its deadline on its own — no metric, no
    // layout commit, no settle signal of any kind arrives here.
    it('reaches the mount-settle deadline exactly once when stability never arrives', async () => {
        const harness = createHarness();
        const hook = await renderHook(() => useTranscriptNativeMountSettleLifecycle(harness.params));

        await advance(DEADLINE_MS - MOUNT_SETTLE_QUIESCENT_WINDOW_MS);
        expect(harness.setNativeMountSettleDeadlineReached).not.toHaveBeenCalled();

        await advance(2 * MOUNT_SETTLE_QUIESCENT_WINDOW_MS);
        expect(harness.setNativeMountSettleDeadlineReached).toHaveBeenCalledWith(true);
        expect(harness.nativeMountSettleDeadlineReachedRef.current).toBe(true);
        expect(harness.setNativeMountSettleStable).not.toHaveBeenCalled();

        const samplesAtDeadline = harness.sampleMountSettle.mock.calls.length;
        await advance(10 * MOUNT_SETTLE_QUIESCENT_WINDOW_MS);
        expect(harness.setNativeMountSettleDeadlineReached).toHaveBeenCalledTimes(1);
        expect(harness.sampleMountSettle.mock.calls.length).toBe(samplesAtDeadline);

        await hook.unmount();
    });

    it('does not run the native mount-settle producer on web', async () => {
        const harness = createHarness({ platformOS: 'web' });
        const hook = await renderHook(() => useTranscriptNativeMountSettleLifecycle(harness.params));

        await advance(4 * DEADLINE_MS);

        expect(harness.sampleMountSettle).not.toHaveBeenCalled();
        expect(harness.setNativeMountSettleStable).not.toHaveBeenCalled();
        expect(harness.setNativeMountSettleDeadlineReached).not.toHaveBeenCalled();
        expect(harness.nativeMountSettleDeadlineReachedRef.current).toBe(false);

        await hook.unmount();
    });

    it('stops sampling once the mount-settle producer is torn down', async () => {
        const harness = createHarness();
        const hook = await renderHook(() => useTranscriptNativeMountSettleLifecycle(harness.params));

        await advance(MOUNT_SETTLE_QUIESCENT_WINDOW_MS);
        const samplesBeforeUnmount = harness.sampleMountSettle.mock.calls.length;
        expect(samplesBeforeUnmount).toBeGreaterThan(0);

        await hook.unmount();
        await advance(4 * DEADLINE_MS);

        expect(harness.sampleMountSettle.mock.calls.length).toBe(samplesBeforeUnmount);
        expect(harness.setNativeMountSettleDeadlineReached).not.toHaveBeenCalled();
    });
});

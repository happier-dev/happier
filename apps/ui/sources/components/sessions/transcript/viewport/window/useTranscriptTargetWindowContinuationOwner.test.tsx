// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { sync } from '@/sync/sync';

import {
    type TranscriptTargetWindowContinuationState,
    useTranscriptTargetWindowContinuationOwner,
} from './useTranscriptTargetWindowContinuationOwner';

type OwnerParams = Parameters<typeof useTranscriptTargetWindowContinuationOwner>[0];
type LoadResult = Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>;

function state(overrides: Partial<TranscriptTargetWindowContinuationState> = {}): TranscriptTargetWindowContinuationState {
    return {
        hasMoreNewer: true,
        hasMoreOlder: true,
        newerCursor: 60,
        olderCursor: 40,
        targetSeq: 50,
        windowId: 'window-50',
        ...overrides,
    };
}

function result(overrides: Partial<LoadResult> = {}): LoadResult {
    return {
        appliedSeqs: [],
        hasMoreNewer: true,
        hasMoreOlder: true,
        newerCursor: 60,
        olderCursor: 40,
        rawSeqs: [],
        status: 'loaded',
        targetPresent: true,
        targetSeq: 50,
        windowId: 'window-50',
        ...overrides,
    };
}

function params(overrides: Partial<OwnerParams> = {}): OwnerParams {
    return {
        activeTargetWindowTargetRef: { current: { kind: 'seq', seq: 50 } },
        activeWindowState: state(),
        isReadyForLoad: () => true,
        isWarmKeepAliveInstance: false,
        sessionActive: true,
        sessionId: 'session-1',
        targetWindowEdgeLoadInFlightRef: { current: null },
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('useTranscriptTargetWindowContinuationOwner', () => {
    it('retries the exact older edge with the same cursor after a bounded transient-failure cooldown', async () => {
        vi.useFakeTimers();
        const cooldownMs = sync.getSyncTuning().transcriptOlderLoadCooldownMs;
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValueOnce(result({ status: 'retryable_error', targetPresent: false }))
            .mockResolvedValue(result());
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: params() },
        );

        hook.getCurrent().observeReachedEdge('older');
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenLastCalledWith(
            'session-1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );

        await vi.advanceTimersByTimeAsync(Math.max(0, cooldownMs - 1));
        expect(load).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(cooldownMs > 0 ? 1 : 0);
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenLastCalledWith(
            'session-1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );

        await vi.advanceTimersByTimeAsync(cooldownMs * 2);
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });

    it('does not retry a persistent not-ready result while parked at the same edge', async () => {
        vi.useFakeTimers();
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(result({ status: 'not_ready', targetPresent: false }));
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: params() },
        );

        hook.getCurrent().observeReachedEdge('older');
        await flushHookEffects();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });

    it('serializes an underfilled two-direction window older-first, then drains newer', async () => {
        let resolveOlder!: (value: LoadResult) => void;
        const older = new Promise<LoadResult>((resolve) => {
            resolveOlder = resolve;
        });
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockReturnValueOnce(older)
            .mockResolvedValue(result());
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: params() },
        );

        hook.getCurrent().observeProximity({ newer: true, older: true });
        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0]?.[2]).toEqual({ direction: 'older' });

        resolveOlder(result());
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(2);
        expect(load.mock.calls[1]?.[2]).toEqual({ direction: 'newer' });
        await hook.unmount();
    });

    it('chains an advanced cursor for the same near window after the shared in-flight owner releases', async () => {
        let resolveFirst!: (value: LoadResult) => void;
        const first = new Promise<LoadResult>((resolve) => {
            resolveFirst = resolve;
        });
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockReturnValueOnce(first)
            .mockResolvedValue(result({ olderCursor: 30 }));
        const shared = params();
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeProximity({ newer: false, older: true });
        expect(load).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...shared,
            activeWindowState: state({ olderCursor: 30 }),
        });
        resolveFirst(result({ olderCursor: 30 }));
        await flushHookEffects();

        expect(load).toHaveBeenCalledTimes(2);
        expect(load.mock.calls[0]?.[2]).toEqual({ direction: 'older' });
        expect(load.mock.calls[1]?.[2]).toEqual({ direction: 'older' });
        await hook.unmount();
    });

    it('does not let a late completion from window A drain into a not-near window B', async () => {
        let resolveA!: (value: LoadResult) => void;
        const loadA = new Promise<LoadResult>((resolve) => {
            resolveA = resolve;
        });
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockReturnValueOnce(loadA)
            .mockResolvedValue(result({ windowId: 'window-b' }));
        const shared = params();
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeProximity({ newer: false, older: true });
        expect(load).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...shared,
            activeWindowState: state({
                newerCursor: 160,
                olderCursor: 140,
                targetSeq: 150,
                windowId: 'window-b',
            }),
        });
        hook.getCurrent().observeProximity({ newer: false, older: false });
        resolveA(result());
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('drains a newly near window B after window A releases the shared in-flight owner without publishing stale A state', async () => {
        let resolveA!: (value: LoadResult) => void;
        const loadA = new Promise<LoadResult>((resolve) => {
            resolveA = resolve;
        });
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockReturnValueOnce(loadA)
            .mockImplementation(() => new Promise(() => {}));
        const shared = params();
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeProximity({ newer: false, older: true });
        expect(load).toHaveBeenCalledTimes(1);

        const windowBTarget = { kind: 'seq' as const, seq: 150 };
        shared.activeTargetWindowTargetRef.current = windowBTarget;
        await hook.rerender({
            ...shared,
            activeWindowState: state({
                newerCursor: 160,
                olderCursor: 140,
                targetSeq: 150,
                windowId: 'window-b',
            }),
        });
        hook.getCurrent().observeProximity({ newer: false, older: true });
        expect(load).toHaveBeenCalledTimes(1);

        resolveA(result({ windowId: 'window-a' }));
        await flushHookEffects();

        expect(shared.activeTargetWindowTargetRef.current).toEqual(windowBTarget);
        expect(load).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenLastCalledWith(
            'session-1',
            { kind: 'seq', seq: 150 },
            { direction: 'older' },
        );
        await hook.unmount();
    });

    it('does not drain a pending target-window continuation after its owner unmounts', async () => {
        let resolveOlder!: (value: LoadResult) => void;
        const older = new Promise<LoadResult>((resolve) => {
            resolveOlder = resolve;
        });
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockReturnValueOnce(older)
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: params() },
        );

        hook.getCurrent().observeProximity({ newer: true, older: true });
        expect(load).toHaveBeenCalledTimes(1);
        await hook.unmount();

        resolveOlder(result());
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending transient-failure retry when the window changes', async () => {
        vi.useFakeTimers();
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(result({ status: 'retryable_error', targetPresent: false }));
        const shared = params();
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeReachedEdge('older');
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...shared,
            activeWindowState: state({
                newerCursor: 160,
                olderCursor: 140,
                targetSeq: 150,
                windowId: 'window-b',
            }),
        });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('cancels a pending transient-failure retry on unmount', async () => {
        vi.useFakeTimers();
        const load = vi.spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(result({ status: 'retryable_error', targetPresent: false }));
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: params() },
        );

        hook.getCurrent().observeReachedEdge('older');
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('re-drives an already-near edge when shared pagination readiness opens', async () => {
        const load = vi.spyOn(sync, 'loadTargetWindowMessages').mockResolvedValue(result());
        const shared = params({ isReadyForLoad: () => false });
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeProximity({ newer: false, older: true });
        expect(load).not.toHaveBeenCalled();

        await hook.rerender({ ...shared, isReadyForLoad: () => true });
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('releases a landed jump window at the same older edge after placement ownership closes', async () => {
        const sessionOpenLatch = createSessionOpenLatch();
        sessionOpenLatch.arm({
            entryKind: 'jump',
            nativeFirstPaintFallbackDelayMs: 450,
            nowMs: 1_000,
            platform: 'web',
            sessionId: 'session-1',
            shouldFollowBottom: false,
            webOpenPhaseDeadlineDelayMs: 30_000,
        });
        let placementTransactionOpen = true;
        const load = vi.spyOn(sync, 'loadTargetWindowMessages').mockResolvedValue(result());
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            {
                initialProps: params({
                    isReadyForLoad: () =>
                        sessionOpenLatch.initialFillStatus() === 'done' &&
                        !placementTransactionOpen,
                }),
            },
        );

        hook.getCurrent().observeReachedEdge('older');
        expect(load).not.toHaveBeenCalled();

        placementTransactionOpen = false;
        expect(sessionOpenLatch.onJumpEntrySettled({ sessionId: 'session-1' })).toBe(true);
        hook.getCurrent().observeProximity({ newer: false, older: true });
        await flushHookEffects();
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(
            'session-1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );
        await hook.unmount();
    });

    it('returns a terminal newer edge to live tail without issuing another window load', async () => {
        const markLiveTail = vi.spyOn(sync, 'markSessionLiveTailIntent').mockImplementation(() => undefined);
        const load = vi.spyOn(sync, 'loadTargetWindowMessages').mockResolvedValue(result());
        const shared = params({
            activeWindowState: state({
                hasMoreNewer: false,
                newerCursor: null,
            }),
        });
        const hook = await renderHook(
            (input: OwnerParams) => useTranscriptTargetWindowContinuationOwner(input),
            { initialProps: shared },
        );

        hook.getCurrent().observeReachedEdge('newer');

        expect(markLiveTail).toHaveBeenCalledWith('session-1');
        expect(shared.activeTargetWindowTargetRef.current).toBeNull();
        expect(load).not.toHaveBeenCalled();
        await hook.unmount();
    });
});

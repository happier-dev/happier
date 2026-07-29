import { describe, expect, it, vi } from 'vitest';

import {
    executeTranscriptTargetWindowJump,
    isTranscriptTargetObservedAtAlignment,
    resolveTranscriptNavigationTargetInRenderedWindow,
    resolveTranscriptTargetWindowHostFacts,
} from './useTranscriptTargetWindowHostAdapter';
import type { TranscriptTargetWindowState } from './transcriptTargetWindowTypes';

const inactiveState: TranscriptTargetWindowState = {
    activatedAtMs: null,
    hasMoreNewer: null,
    hasMoreOlder: null,
    isWindowMode: false,
    newerCursor: null,
    olderCursor: null,
    targetSeq: null,
    windowId: null,
    windowMaxSeq: null,
    windowMinSeq: null,
};

function createRect(top: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left: 0,
        right: 0,
        top,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

describe('isTranscriptTargetObservedAtAlignment', () => {
    it('uses live row geometry and the same clamp-aware center/top coordinates as the web driver', () => {
        const element = {
            getBoundingClientRect: () => createRect(50, 500),
        } as HTMLElement;
        const item = {
            getBoundingClientRect: () => createRect(250, 100),
        };

        expect(isTranscriptTargetObservedAtAlignment({
            align: { kind: 'center' },
            item,
            metrics: {
                clientHeight: 500,
                element,
                scrollHeight: 2000,
                scrollTop: 200,
            },
        })).toBe(true);
        expect(isTranscriptTargetObservedAtAlignment({
            align: { kind: 'top-with-item-offset', itemOffsetPx: 40 },
            item,
            metrics: {
                clientHeight: 500,
                element,
                scrollHeight: 700,
                scrollTop: 200,
            },
        })).toBe(true);
        expect(isTranscriptTargetObservedAtAlignment({
            align: { kind: 'center' },
            item: {
                getBoundingClientRect: () => createRect(190, 100),
            },
            metrics: {
                clientHeight: 500,
                element,
                scrollHeight: 2000,
                scrollTop: 260,
            },
        })).toBe(false);
    });
});

describe('resolveTranscriptNavigationTargetInRenderedWindow', () => {
    it('requires live DOM presence on web even when the item space claims the target', () => {
        // Live RG2 class: on web the item space covers ALL loaded items, so a
        // loaded-but-virtualized-out rail target reads as "in the rendered window" and the
        // jump plan skips target-window materialization entirely, accepting a wrong-space
        // write. Rendered-window truth on web is DOM mount presence.
        expect(resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS: 'web',
            isTargetInItemSpace: true,
            isTargetMountedInDom: () => false,
        })).toBe(false);
        expect(resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS: 'web',
            isTargetInItemSpace: true,
            isTargetMountedInDom: () => true,
        })).toBe(true);
    });

    it('keeps item-space truth on native and for absent targets', () => {
        expect(resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS: 'ios',
            isTargetInItemSpace: true,
            isTargetMountedInDom: () => false,
        })).toBe(true);
        expect(resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS: 'web',
            isTargetInItemSpace: false,
            isTargetMountedInDom: () => true,
        })).toBe(false);
    });
});

describe('transcript target-window host adapter', () => {
    it('keeps tail display inactive when the session has no active target window', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [{ id: 'row-1', seq: 1 }],
            windowState: inactiveState,
        });

        expect(facts.targetWindowActive).toBe(false);
        expect(facts.items).toEqual([{ id: 'row-1', seq: 1 }]);
        expect(facts.hasMoreNewer).toBe(false);
        expect(facts.gaps).toEqual({ newer: null, older: null });
    });

    it('derives display items and hasMoreNewer from active window state instead of hard-coding false', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'row-1', seq: 98 },
                { id: 'row-2', seq: 99 },
                { id: 'row-3', seq: 100 },
                { id: 'row-4', seq: 250 },
            ],
            windowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 100,
                olderCursor: 98,
                targetSeq: 99,
                windowId: 'window-99',
                windowMaxSeq: 100,
                windowMinSeq: 98,
            },
        });

        expect(facts.targetWindowActive).toBe(true);
        expect(facts.hasMoreNewer).toBe(true);
        expect(facts.display?.windowId).toBe('window-99');
        expect(facts.items.map((item) => item.id)).toEqual(['row-1', 'row-2', 'row-3']);
        expect(facts.gaps).toEqual({
            newer: {
                direction: 'newer',
                id: 'transcript-window-gap:window-99:newer',
            },
            older: {
                direction: 'older',
                id: 'transcript-window-gap:window-99:older',
            },
        });
    });

    it('does not infer missing messages from omitted synthetic rows', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'synthetic-before' },
                { id: 'row-98', seq: 98 },
                { id: 'row-99', seq: 99 },
                { id: 'synthetic-after' },
            ],
            windowState: {
                activatedAtMs: 1,
                hasMoreNewer: false,
                hasMoreOlder: false,
                isWindowMode: true,
                newerCursor: null,
                olderCursor: null,
                targetSeq: 99,
                windowId: 'window-99',
                windowMaxSeq: 99,
                windowMinSeq: 98,
            },
        });

        expect(facts.gaps).toEqual({ newer: null, older: null });
    });

    it('does not create an inert gap marker when authoritative coverage spans more than 512 seqs', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'row-100', seq: 100 },
                { id: 'row-900', seq: 900 },
            ],
            isSeqRangeLoaded: (fromInclusive, toInclusive) => (
                fromInclusive >= 100 && toInclusive <= 900
            ),
            windowState: {
                activatedAtMs: 1,
                hasMoreNewer: false,
                hasMoreOlder: false,
                isWindowMode: true,
                newerCursor: null,
                olderCursor: null,
                targetSeq: 100,
                windowId: 'window-100',
                windowMaxSeq: 900,
                windowMinSeq: 100,
            },
        });

        expect(facts.items.map((item) => item.id)).toEqual(['row-100', 'row-900']);
        expect(facts.gaps).toEqual({ newer: null, older: null });
    });

    it('fails a target-window jump when the logical target never mounts after a no-movement write', async () => {
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-500' }));
        const onJumpLanded = vi.fn();

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: vi.fn()
                .mockReturnValueOnce(100)
                .mockReturnValueOnce(100),
            resolveTargetIndex: () => ({ status: 'found', index: 2, seq: 500, routeMessageId: null }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('fails a target-window jump when a moving write still never mounts the logical target', async () => {
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-331' }));
        const onJumpLanded = vi.fn();

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: vi.fn()
                .mockReturnValueOnce(10_820)
                .mockReturnValueOnce(10_548),
            resolveTargetIndex: () => ({ status: 'found', index: 29, seq: 331, routeMessageId: 'server:m331' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('revalidates DOM mount presence after a moving web scroll even when the rendered-window item space still claims the target', async () => {
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-331' }));
        const onJumpLanded = vi.fn();
        const isTargetInRenderedWindow = vi.fn(() => true);
        const isTargetMounted = vi.fn(() => false);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow,
            isTargetMounted,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: vi.fn()
                .mockReturnValueOnce(11_224)
                .mockReturnValueOnce(10_952),
            resolveTargetIndex: () => ({ status: 'found', index: 29, seq: 331, routeMessageId: 'server:m331' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(isTargetInRenderedWindow).toHaveBeenCalled();
        expect(isTargetMounted).toHaveBeenCalled();
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('does not issue an ad-hoc newer page after target-window activation', async () => {
        const loadTargetWindow = vi.fn(async (request: { direction: 'older' | 'newer' | null }) => (
            request.direction === 'newer'
                ? { windowId: 'window-253', targetSeq: 253, newerCursor: 258, hasMoreNewer: true }
                : { windowId: 'window-253', targetSeq: 253, newerCursor: 253, hasMoreNewer: true }
        ));

        const result = await executeTranscriptTargetWindowJump({
            align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
            canRenderTargetWindow: true,
            isTargetMounted: () => true,
            loadTargetWindow,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 253 },
            targetSeq: 253,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 253 },
            windowId: 'window-253',
        });
        expect(loadTargetWindow).toHaveBeenNthCalledWith(1, {
            direction: null,
            target: { kind: 'seq', seq: 253 },
            targetSeq: 253,
        });
        expect(loadTargetWindow).toHaveBeenCalledTimes(1);
    });

    it('maps stale target-window loads to an aborted jump result', async () => {
        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow: vi.fn(async () => ({ status: 'stale' as const })),
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({ status: 'aborted' });
    });

    it('fires web target-window landing after the rendered target becomes mounted', async () => {
        const onJumpLanded = vi.fn();
        const isTargetMounted = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValue(true);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-500' })),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 500 },
            windowId: 'window-500',
        });
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('does not report target-window success until the mounted logical target is at the requested alignment', async () => {
        const onJumpLanded = vi.fn();
        const isTargetAligned = vi.fn(() => false);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetAligned,
            isTargetMounted: () => true,
            landingSettleDeadlineMs: 0,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-500' })),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => 100,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(isTargetAligned).toHaveBeenCalled();
        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('lands the web viewport on the target after a scroll-mounted fallback materialization', async () => {
        // RG1 in-app class: strategy resolves scroll-mounted (item-space found), the write-time
        // mounted gate refutes it, the fallback materializes a target window — the landing must
        // then scroll onto the mounted target instead of leaving the viewport parked wrong-space.
        const onJumpLanded = vi.fn();
        const isTargetMounted = vi.fn(() => true).mockReturnValueOnce(false);
        const scrollToTarget = vi.fn(() => true);
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-331' }));

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => 100,
            resolveTargetIndex: () => ({ status: 'found', index: 29, seq: 331, routeMessageId: 'server:m331' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 331 },
            windowId: 'window-331',
        });
        expect(scrollToTarget.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('re-runs the exact landing write until the mounted target stops moving under late measurements', async () => {
        // RG1 cold class: the first landing write resolves against estimated row layouts; late
        // measurements shift content and leave the target 10-30 rows below the viewport. The
        // landing loop must settle-correct against the live layout until stable.
        const onJumpLanded = vi.fn();
        const scrollToTarget = vi.fn(() => true);
        const readScrollTop = vi.fn()
            .mockReturnValueOnce(0) // metrics availability probe
            .mockReturnValueOnce(0) // frame 1 pre-write
            .mockReturnValueOnce(500) // frame 1 post-write (moved)
            .mockReturnValueOnce(500) // frame 2 pre-write
            .mockReturnValueOnce(520) // frame 2 post-write (late measurement shifted layout)
            .mockReturnValueOnce(520) // frame 3 pre-write
            .mockReturnValueOnce(520) // frame 3 post-write (stable x1)
            .mockReturnValueOnce(520) // frame 4 pre-write
            .mockReturnValueOnce(520); // frame 4 post-write (stable x2 -> settled)

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            loadTargetWindow: async () => ({ windowId: 'window-301' }),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 301 },
            targetSeq: 301,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(result.status).toBe('window-rendered');
        expect(scrollToTarget.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
    });

    it('stops landing corrections when a foreign writer moves the viewport', async () => {
        const onJumpLanded = vi.fn();
        const scrollToTarget = vi.fn(() => true);
        const readScrollTop = vi.fn()
            .mockReturnValueOnce(0) // metrics availability probe
            .mockReturnValueOnce(0) // frame 1 pre-write
            .mockReturnValueOnce(500) // frame 1 post-write
            .mockReturnValue(900); // frame 2 pre-write: viewport moved by someone else

        await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            loadTargetWindow: async () => ({ windowId: 'window-301' }),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 301 },
            targetSeq: 301,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(scrollToTarget).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
    });

    it('keeps correcting through renderer-induced scrollTop drift when the genuine-movement owner reports none', async () => {
        // Live RG1 rerun evidence: while the target window is still materializing, renderer
        // re-slices and browser scroll anchoring move scrollTop without any user input. With the
        // host genuine-movement signal available and quiet, the landing loop must keep approaching
        // instead of treating renderer drift as a foreign writer.
        const onJumpLanded = vi.fn();
        const scrollToTarget = vi.fn(() => true);
        const isTargetMounted = vi.fn(() => true)
            .mockReturnValueOnce(false) // landing frame 1: still unmounted (approach write)
            .mockReturnValueOnce(false); // landing frame 2: renderer drifted scrollTop, still unmounted
        const readScrollTop = vi.fn()
            .mockReturnValueOnce(0) // metrics availability probe
            .mockReturnValueOnce(0) // frame 1 pre-write
            .mockReturnValueOnce(500) // frame 1 post-write
            .mockReturnValueOnce(760) // frame 2 pre-write: renderer moved viewport (NOT the user)
            .mockReturnValueOnce(760) // frame 2 post-write
            .mockReturnValueOnce(760) // frame 3 pre-write
            .mockReturnValueOnce(760) // frame 3 post-write (mounted exact, stable x1)
            .mockReturnValueOnce(760) // frame 4 pre-write
            .mockReturnValueOnce(760); // frame 4 post-write (stable x2 -> settled)

        await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            hasGenuineUserMovementSince: () => false,
            isTargetInRenderedWindow: () => true,
            isTargetMounted,
            loadTargetWindow: async () => ({ windowId: 'window-331' }),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(scrollToTarget.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
    });

    it('aborts landing corrections when the genuine-movement owner reports user movement', async () => {
        const onJumpLanded = vi.fn();
        const scrollToTarget = vi.fn(() => true);
        const hasGenuineUserMovementSince = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValue(true);

        await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            hasGenuineUserMovementSince,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            loadTargetWindow: async () => ({ windowId: 'window-331' }),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => 100,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(scrollToTarget).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
    });

    it('returns aborted without post-supersession writes when a newer loaded-target jump starts between landing frames', async () => {
        let currentOperation = true;
        let writesAfterSupersession = 0;
        const scrollToTarget = vi.fn(() => {
            if (!currentOperation) writesAfterSupersession += 1;
            return true;
        });
        let frameCount = 0;

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: false,
            isCurrentOperation: () => currentOperation,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            loadTargetWindow: vi.fn(async () => null),
            platformOS: 'web',
            readScrollTop: () => 100,
            resolveTargetIndex: () => ({ status: 'found', index: 0, seq: 100, routeMessageId: null }),
            scrollToTarget,
            target: { kind: 'seq', seq: 100 },
            targetSeq: 100,
            waitForNextLandingFrame: async () => {
                frameCount += 1;
                if (frameCount === 1) currentOperation = false;
            },
        });

        expect(result).toEqual({ status: 'aborted' });
        expect(writesAfterSupersession).toBe(0);
    });

    it('does not run the retired FlashList chunk nudge on the Legend-only target-window path', async () => {
        const onJumpLanded = vi.fn();
        let nudged = false;
        const nudgeScrollForGap = vi.fn().mockImplementation(() => { nudged = true; });
        const isTargetMounted = vi.fn().mockImplementation(() => nudged);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            hasGenuineUserMovementSince: () => false,
            isTargetInRenderedWindow: () => true,
            isTargetMounted,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
            // @ts-expect-error The Legend-only contract rejects the retired FlashList nudge hook.
            nudgeScrollForGap,
            onJumpLanded,
            platformOS: 'web',
            // Stable scrollTop throughout — simulates the blank-chunk gap condition where
            // approach writes apply but scrollTop does not move.
            readScrollTop: vi.fn().mockReturnValue(22470),
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 41 },
            targetSeq: 41,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(nudgeScrollForGap).not.toHaveBeenCalled();
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('does not retain the retired FlashList post-settle chase in the Legend-only host adapter', async () => {
        const onJumpLanded = vi.fn();
        let scrollTop = 0;
        let targetScrollTop = 22470;
        let frames = 0;

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            hasGenuineUserMovementSince: () => false,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => scrollTop,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => {
                scrollTop = targetScrollTop;
                return true;
            }),
            target: { kind: 'seq', seq: 41 },
            targetSeq: 41,
            waitForNextLandingFrame: () => {
                frames += 1;
                // Simulate the post-settle reallocation: the main landing loop settles within
                // the first few frames; the drift lands afterwards, during re-verification.
                if (frames === 6) targetScrollTop = 16578;
                return Promise.resolve();
            },
        });

        expect(result.status).toBe('window-rendered');
        expect(scrollTop).toBe(22470);
        expect(frames).toBe(2);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('ends app landing ownership as soon as the exact target write installs the matching renderer hold', async () => {
        let nowMs = 1_000;
        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        let heldItemId: string | null = null;
        const waitForNextLandingFrame = vi.fn(async () => {
            nowMs += 20_000;
        });
        const scrollToTarget = vi.fn(() => {
            heldItemId = 'target-row';
            return true;
        });

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            isTargetOwnedByRenderer: () => heldItemId === 'target-row',
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
            platformOS: 'web',
            readScrollTop: () => 22_470,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 41 },
            targetSeq: 41,
            waitForNextLandingFrame,
        });
        dateNow.mockRestore();

        expect(result.status).toBe('window-rendered');
        expect(scrollToTarget).toHaveBeenCalledTimes(1);
        expect(waitForNextLandingFrame).not.toHaveBeenCalled();
    });

    it('does not issue a no-hold reverify write when its awaited frame resumes after the deadline', async () => {
        let nowMs = 1_000;
        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        let waitCount = 0;
        const waitForNextLandingFrame = vi.fn(async () => {
            waitCount += 1;
            if (waitCount === 1) nowMs += 16_000;
        });
        const scrollToTarget = vi.fn(() => true);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            isTargetOwnedByRenderer: () => false,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
            platformOS: 'web',
            readScrollTop: () => 22_470,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 41 },
            targetSeq: 41,
            waitForNextLandingFrame,
        });
        dateNow.mockRestore();

        expect(result.status).toBe('window-rendered');
        expect(scrollToTarget).toHaveBeenCalledTimes(1);
    });

    it('keeps the app landing path active when the renderer hold belongs to another item', async () => {
        const scrollToTarget = vi.fn(() => true);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetInRenderedWindow: () => true,
            isTargetMounted: () => true,
            isTargetOwnedByRenderer: () => false,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
            platformOS: 'web',
            readScrollTop: () => 22_470,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget,
            target: { kind: 'seq', seq: 41 },
            targetSeq: 41,
            waitForNextLandingFrame: () => Promise.resolve(),
        });

        expect(result.status).toBe('window-rendered');
        expect(scrollToTarget.mock.calls.length).toBeGreaterThan(1);
    });

    it('pages nearby unresolved targets before replacing the list with a target window', async () => {
        const pageTowardTarget = vi.fn(async () => ({
            status: 'scrolled' as const,
            target: { kind: 'seq' as const, seq: 103 },
        }));
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-103' }));

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => true,
            loadTargetWindow,
            pageTowardTarget,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({
                status: 'unresolved',
                direction: 'older',
                targetSeq: 103,
                nearestIndex: 0,
                nearestSeq: 100,
            }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 103 },
            targetSeq: 103,
        });

        expect(result).toEqual({ status: 'scrolled', target: { kind: 'seq', seq: 103 } });
        expect(pageTowardTarget).toHaveBeenCalledWith({
            direction: 'older',
            nearestIndex: 0,
            nearestSeq: 100,
            target: { kind: 'seq', seq: 103 },
            targetSeq: 103,
        });
        expect(loadTargetWindow).not.toHaveBeenCalled();
    });
});

describe('tail contiguous floor (tail-reset discontinuity display)', () => {
    const activeWindowState: TranscriptTargetWindowState = {
        activatedAtMs: 1,
        hasMoreNewer: false,
        hasMoreOlder: true,
        isWindowMode: true,
        newerCursor: null,
        olderCursor: 5,
        targetSeq: 6,
        windowId: 'w1',
        windowMaxSeq: 8,
        windowMinSeq: 5,
    };

    it('bounds tail display to the tail-contiguous island when a floor is set', () => {
        // Store shape after a tail-reset over an existing prefix: [401..410] + HOLE +
        // [1951..2000]. Without the floor the tail glued yesterday directly onto the
        // island (live defect 2026-07-12).
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'y-401', seq: 401 },
                { id: 'y-410', seq: 410 },
                { id: 't-1951', seq: 1951 },
                { id: 't-2000', seq: 2000 },
            ],
            tailContiguousFloorSeq: 1951,
            windowState: inactiveState,
        });
        expect(facts.targetWindowActive).toBe(false);
        expect(facts.items.map((item) => item.id)).toEqual(['t-1951', 't-2000']);
        expect(facts.gaps.older).toEqual({
            direction: 'older',
            id: 'transcript-window-gap:tail:older',
        });
    });

    it('keeps seq-less rows and clears nothing when the floor is null', () => {
        const items = [
            { id: 'synthetic' },
            { id: 'y-401', seq: 401 },
            { id: 't-1951', seq: 1951 },
        ];
        const floored = resolveTranscriptTargetWindowHostFacts({
            items,
            tailContiguousFloorSeq: 1951,
            windowState: inactiveState,
        });
        expect(floored.items.map((item) => item.id)).toEqual(['synthetic', 't-1951']);
        expect(floored.gaps.older?.id).toBe('transcript-window-gap:tail:older');

        const unfloored = resolveTranscriptTargetWindowHostFacts({
            items,
            tailContiguousFloorSeq: null,
            windowState: inactiveState,
        });
        expect(unfloored.items).toBe(items);
        expect(unfloored.gaps).toEqual({ newer: null, older: null });
    });

    it('ignores the floor while a target window is active (jumps below the floor must render)', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'w-5', seq: 5 },
                { id: 'w-6', seq: 6 },
                { id: 'w-7', seq: 7 },
                { id: 't-1951', seq: 1951 },
            ],
            tailContiguousFloorSeq: 1951,
            windowState: activeWindowState,
        });
        expect(facts.targetWindowActive).toBe(true);
        expect(facts.items.map((item) => item.id)).toEqual(['w-5', 'w-6', 'w-7']);
    });
});

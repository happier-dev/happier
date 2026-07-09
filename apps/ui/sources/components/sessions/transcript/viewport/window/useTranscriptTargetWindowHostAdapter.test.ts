import { describe, expect, it, vi } from 'vitest';

import {
    executeTranscriptTargetWindowJump,
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
    });

    it('forces a target-window render when a mounted scroll reports no real movement', async () => {
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

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 500 },
            windowId: 'window-500',
        });
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('forces a target-window render when a web mounted scroll moves but the target is still not mounted', async () => {
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

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 331 },
            windowId: 'window-331',
        });
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

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 331 },
            windowId: 'window-331',
        });
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
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(true);

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
        // Live RG1 rerun evidence: while the target window is still materializing, FlashList
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

    it('nudges scrollTop to force FlashList chunk re-render when approach writes are stable but target is unmounted (P2SMOKE3-S3-JUMP-GAP)', async () => {
        // Live S3 evidence: route jumpSeq=41, st=22470 correct but FlashList chunk 1 has a
        // 6793px blank allocation gap (17449–24240) from streaming-growth reallocation.
        // Approach writes re-write st=22470 every frame; FlashList's scroll listener never
        // fires because scrollTop does not change. nudgeScrollForGap fires after 2 stable
        // non-mounted frames, changing scrollTop by 1px to trigger FlashList chunk population.
        const onJumpLanded = vi.fn();
        // State-based mock: target unmounted until nudge fires, then mounted.
        // scrollToTarget() calls isTargetMounted() internally, so a call-count mock would
        // couple to implementation details; a state-based mock encodes the real contract.
        let nudged = false;
        const nudgeScrollForGap = vi.fn().mockImplementation(() => { nudged = true; });
        const isTargetMounted = vi.fn().mockImplementation(() => nudged);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            hasGenuineUserMovementSince: () => false,
            isTargetInRenderedWindow: () => true,
            isTargetMounted,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-41' })),
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

        expect(result.status).toBe('window-rendered');
        // Nudge must fire exactly once (at 2 stable non-mounted frames) before the target mounts.
        expect(nudgeScrollForGap).toHaveBeenCalledTimes(1);
        // Landing must be confirmed exactly once after nudge allows FlashList to render.
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('re-corrects the settled landing when FlashList reallocation moves the target post-settle (P2SMOKE3-S3-JUMP-GAP)', async () => {
        // Live S3 evidence: landing settles at st=22470 (correct at write time), then FlashList
        // async re-measurement + streaming growth collapse estimated heights and move the target
        // row to absTop≈16578 — the settled viewport is left in an unrendered allocation gap.
        // The bounded post-settle re-verification must follow the target to its new position.
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
        // The re-verification pass must have chased the drifted layout to its new position.
        expect(scrollTop).toBe(16578);
        // Landing is still reported exactly once — re-verification corrects, never re-lands.
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('pages nearby unresolved targets before replacing the list with a target window', async () => {
        const pageTowardTarget = vi.fn(async () => ({
            status: 'scrolled' as const,
            target: { kind: 'seq' as const, seq: 103 },
        }));
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-103' }));

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
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
            scrollToTarget: vi.fn(() => false),
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

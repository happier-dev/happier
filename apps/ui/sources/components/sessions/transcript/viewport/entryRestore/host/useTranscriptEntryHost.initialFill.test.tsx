/**
 * Session-open initial fill: ONE fill-sufficiency contract, displayable-content based (S-L/S-M,
 * 2026-07-11).
 *
 * Live defect (S-L screenshot): older pages are counted in RAW applied events, but
 * sidechain-routed events are filtered out of the main transcript lane — a session whose recent
 * history is sidechain-heavy opened to a lone "Tool calls · 2" row and a blank screen. The fill
 * loop's sufficiency check was already displayable-based (scrollability), but its BOUND was a
 * wall-clock budget measured from the start of the fill: a run of legitimately raw-only pages
 * exhausted the budget before any displayable row arrived, leaving the transcript underfilled
 * (content < viewport = no scroll = the older-load trigger can never arm = stuck, S-M).
 *
 * Contract pinned here:
 * - the no-progress budget bounds time WITHOUT DISPLAYABLE progress (main-lane content height
 *   growth), not total time, so bounded chains of sidechain-only pages keep filling;
 * - a hard absolute ceiling still bounds pathological fills (stale counters, endless histories).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { SessionEntryViewportRefValue } from './useTranscriptEntryHost';
import { useTranscriptEntryHost } from './useTranscriptEntryHost';
import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionViewport: () => null,
        loadTargetWindowMessages: vi.fn(),
        getSyncTuning: () => ({
            transcriptInitialFillBudgetMs: 2000,
            transcriptInitialFillMaxNoProgressLoads: 3,
            transcriptViewportAnchorOlderLookupMaxLoads: 6,
        }),
    },
}));
vi.mock('@/sync/domains/state/storage', () => ({
    getStorage: () => ({ getState: () => ({}) }),
}));

type EntryHostDeps = Parameters<typeof useTranscriptEntryHost>[0];

function createFillHarness(params: Readonly<{
    layoutHeightPx: number;
    initialContentHeightPx: number;
    /** Per-load displayable main-lane content growth in px (0 = sidechain-only raw page). */
    contentGrowthPerLoadPx: readonly number[];
    loadDurationMs: number;
    hasMoreAfterPlan?: boolean;
}>) {
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const listContentHeightRef = { current: params.initialContentHeightPx };
    const listLayoutHeightRef = { current: params.layoutHeightPx };
    const isScrollable = vi.fn(() => listContentHeightRef.current > listLayoutHeightRef.current + 16);
    const loadOlder = vi.fn<EntryHostDeps['loadOlder']>(async () => {
        nowMs += params.loadDurationMs;
        const growth = params.contentGrowthPerLoadPx[loadOlder.mock.calls.length - 1];
        if (growth === undefined) {
            if (params.hasMoreAfterPlan === true) {
                return { status: 'loaded' as const, loaded: 8, hasMore: true };
            }
            return { status: 'no_more' as const, loaded: 0, hasMore: false };
        }
        listContentHeightRef.current += growth;
        return { status: 'loaded' as const, loaded: 8, hasMore: true };
    });

    const sessionOpenLatch = createSessionOpenLatch();
    sessionOpenLatch.arm({
        entryKind: 'bottom',
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs,
        platform: 'native',
        sessionId: 's1',
        shouldFollowBottom: true,
        webOpenPhaseDeadlineDelayMs: 30_000,
    });

    const items: readonly ChatTranscriptListItem[] = [];
    const renderWindowProjection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
        createWindowGapItem: createTranscriptWindowGapItem,
        items,
        listOrientation: 'standard',
        sessionId: 's1',
        targetWindowState: {
            isWindowMode: false,
            windowId: null,
            targetSeq: null,
            windowMinSeq: null,
            windowMaxSeq: null,
            olderCursor: null,
            newerCursor: null,
            hasMoreOlder: null,
            hasMoreNewer: null,
            activatedAtMs: null,
        },
    });

    const deps: EntryHostDeps = {
        activeTargetWindowTargetRef: { current: null },
        anchorLookupExhaustedRef: { current: false },
        anchorLookupInFlightRef: { current: false },
        anchorLookupLoadCountRef: { current: 0 },
        applyEntryRestoreOwnerEffectsRef: { current: () => {} },
        applySessionOpenArmResetPlan: vi.fn(),
        applySessionOpenDisposeResetPlan: vi.fn(),
        applySessionOpenLatchEffectsRef: { current: () => {} },
        attemptEntryRestoreRef: { current: () => {} },
        closeEntryViewportOwnership: vi.fn(),
        committedMessagesCount: 5,
        composerInsetHeightRef: { current: 0 },
        currentSessionIdRef: { current: 's1' },
        decomposedItems: items,
        displayItemsLength: 1,
        disposeEntryRestoreTransactionForExitRef: { current: () => {} },
        entryRestoreDeadlineTimeoutRef: { current: null },
        entryRestoreOwner: createEntryRestoreOwner(),
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => true),
        initialFillAbortRef: { current: null },
        invalidateViewportAnchorCapture: vi.fn(),
        isLoaded: true,
        isScrollable,
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        jumpToSeq: null,
        lastScrollOffsetForIntentRef: { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        userScrollIntent: createTranscriptUserScrollIntentOwner(),
        latestJumpToSeqRef: { current: null },
        listContentHeight: params.initialContentHeightPx,
        listContentHeightRef,
        listDataLength: 1,
        listDataRef: { current: items },
        listLayoutHeight: params.layoutHeightPx,
        listLayoutHeightRef,
        listRef: { current: null },
        loadOlder,
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleDeadlineReachedRef: { current: false },
        nativeMountSettleStable: false,
        observeMountSettleMetrics: vi.fn(),
        pinThresholdPx: 32,
        recordRestoreDecisionTelemetry: vi.fn(),
        recordEntryOwnerOutcome: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        renderWindowProjection,
        resolveEntryRestoreOwnerAnchor: vi.fn<EntryHostDeps['resolveEntryRestoreOwnerAnchor']>(() => null),
        resolveNearestSurvivingViewportAnchorIndex: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndex']>(() => null),
        resolveNearestSurvivingViewportAnchorIndexFromItems: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndexFromItems']>(() => null),
        resolveSeqForViewportAnchor: vi.fn<EntryHostDeps['resolveSeqForViewportAnchor']>(() => null),
        resolveViewportCommand: vi.fn(() => ({
            kind: 'none' as const,
            sessionId: 's1',
            reason: 'test',
            mode: 'hydrating' as const,
        })),
        resolveWebScrollMetrics: vi.fn(() => null),
        restoreWebViewportAnchorThroughViewportCommand: vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        sessionEntryViewportRef: { current: null as SessionEntryViewportRefValue },
        sessionId: 's1',
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        wantsPinnedRef: { current: true },
    };

    return { deps, isScrollable, listContentHeightRef, loadOlder, sessionOpenLatch };
}

describe('useTranscriptEntryHost initial fill sufficiency (S-L/S-M)', () => {
    const originalPlatformOS = Platform.OS;

    beforeEach(() => {
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        return () => {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
            vi.restoreAllMocks();
        };
    });

    /**
     * Ported by intent from the 0.2 line (PR #305 + follow-ups): web session-open must not
     * serialize historical backfill before the latch settles, but it must still hand the
     * older pager a SCROLLABLE transcript — `olderPaginationMachine` cannot arm while
     * `scrollable === false` (both validity paths require it), so an underfilled open has no
     * way to ask for more history. Settling first and filling after satisfies both.
     *
     * 0.3 mapping note: the page-size intents from that batch do not apply here.
     * `fetchAndApplyMessages` takes no `limit` in this line and there is no configurable
     * session-messages page size, so there is nothing to diverge from or undo.
     */
    it('settles web session open without waiting for history: zero loads, zero elapsed ms', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });
        const openedAtMs = Date.now();

        const latch = harness.deps.sessionOpenLatch;
        const settleOriginal = latch.onInitialFillSettled.bind(latch);
        const settleObservation: { value: Readonly<{ atMs: number; loads: number }> | null } = { value: null };
        (latch as { onInitialFillSettled: typeof latch.onInitialFillSettled }).onInitialFillSettled = (args) => {
            settleObservation.value ??= { atMs: Date.now(), loads: harness.loadOlder.mock.calls.length };
            return settleOriginal(args);
        };

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });

        expect(settleObservation.value?.loads).toBe(0);
        expect(settleObservation.value!.atMs - openedAtMs).toBe(0);
    });

    it('web post-settle fill stays out of an ANCHORED entry, whose anchor lookup owns the loader', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });
        harness.deps.sessionEntryViewportRef.current = { shouldFollowBottom: false } as SessionEntryViewportRefValue;

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(harness.loadOlder).not.toHaveBeenCalled();
    });

    it('web post-settle fill yields to a load already in flight instead of burning its budget', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });
        harness.loadOlder.mockResolvedValue({ status: 'in_flight' as const, loaded: 0, hasMore: true });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Retries a bounded number of times, then stops — never counting these against the
        // no-progress budget, and never holding on indefinitely.
        expect(harness.loadOlder.mock.calls.length).toBeGreaterThan(1);
        expect(harness.loadOlder.mock.calls.length).toBeLessThanOrEqual(8);
    });

    it('web post-settle fill RESUMES after a transient loader answer, rather than giving up', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        // `not_ready` is what the loader answers while the older cursor has not been
        // materialized — the normal state immediately after open, which is when this runs.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            // The harness indexes growth by call count, and the injected transient answer
            // consumes the first slot, so the real page is the second entry.
            contentGrowthPerLoadPx: [0, 500],
            loadDurationMs: 10,
        });
        const realLoadOlder = harness.loadOlder.getMockImplementation()!;
        let answered = false;
        harness.loadOlder.mockImplementation(async (options?: unknown) => {
            if (!answered) {
                answered = true;
                return { status: 'not_ready' as const, loaded: 0, hasMore: true };
            }
            return realLoadOlder(options as never);
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.isScrollable()).toBe(true);
        }, { timeout: 5000 });

        expect(harness.loadOlder.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('web still reaches a scrollable transcript, so the older pager can arm at all', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 250, 250],
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.isScrollable()).toBe(true);
        }, { timeout: 5000 });
    });

    it('web post-settle fill does NOTHING when the first page already fills the viewport', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 2400,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(harness.loadOlder).not.toHaveBeenCalled();
    });

    it('keeps filling through raw-only (sidechain) pages until displayable content is sufficient', async () => {
        // Pages 1-2 apply raw events only (all sidechain-routed: zero main-lane growth).
        // Pages 3-4 add displayable rows; page 4 makes the transcript scrollable.
        // Each load takes 700ms, so the old start-anchored 2000ms budget expired after 3
        // loads — one page short of displayable sufficiency — and the user was left stuck
        // on an underfilled transcript.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 0, 250, 250],
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });

        expect(harness.loadOlder).toHaveBeenCalledTimes(4);
        expect(harness.listContentHeightRef.current).toBe(700);
        expect(harness.isScrollable()).toBe(true);
    });

    it('reaches a parent/root row after three sidechain-only pages while older history remains', async () => {
        // The newest loaded page and the next three older pages can all normalize into
        // sidechain-only rows. They advance the one authoritative older cursor but add no
        // main-lane height. The fourth page is the parent/root row that makes the transcript
        // useful again. Treating the three renderless pages as terminal no-progress leaves an
        // empty, unscrollable root with `hasMore` still true and no way to re-arm pagination.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 0, 0, 500],
            loadDurationMs: 10,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.isScrollable()).toBe(true);
        });

        expect(harness.loadOlder).toHaveBeenCalledTimes(4);
        expect(harness.listContentHeightRef.current).toBe(700);
    });

    it('settles the latch even when a fill load rejects', async () => {
        // Every terminal path of the fill executor — completion, abort, or failure —
        // must settle the open lifecycle.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 0, 0],
            loadDurationMs: 100,
        });
        harness.loadOlder.mockRejectedValue(new Error('load transport died'));

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });
        expect(harness.sessionOpenLatch.phase()).toBe('done');
    });

    it('stops a displayable-progress-starved fill at the bounded budget window', async () => {
        // An endless run of raw-only pages must not fetch forever: with no displayable
        // progress the budget window (2000ms) expires and the fill settles underfilled.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            loadDurationMs: 700,
            hasMoreAfterPlan: true,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });

        // Window expires after ceil(2000 / 700) = 3 loads without displayable growth.
        expect(harness.loadOlder.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('stops a perpetually-growing but never-sufficient fill at the absolute ceiling', async () => {
        // Displayable progress on every page keeps resetting the window; the absolute
        // ceiling (5x budget) still bounds the fill.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: Array.from({ length: 100 }, () => 10),
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.sessionOpenLatch.initialFillStatus()).toBe('done');
        });

        // Absolute ceiling: 5x budget = 10000ms => at most ceil(10000/700) = 15 loads.
        expect(harness.loadOlder.mock.calls.length).toBeLessThanOrEqual(15);
    });
});

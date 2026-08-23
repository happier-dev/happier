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
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import { sync } from '@/sync/sync';
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
            transcriptWebInitialPinStabilizeMs: 3000,
            transcriptWebInitialPinRetryIntervalMs: 250,
            transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
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
    const loadOlder = vi.fn(async () => {
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
        isNativeFlashListBottomMaintenanceEnabled: false,
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs,
        platform: 'native',
        sessionId: 's1',
        shouldFollowBottom: true,
        webInitialPinRetryDelaysMs: [],
        webInitialPinStabilizeMs: 0,
        webOpenPhaseDeadlineDelayMs: 30_000,
    });

    const items: readonly ChatTranscriptListItem[] = [];
    const renderWindowProjection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
        activeThinkingMessageId: null,
        createWindowGapItem: createTranscriptWindowGapItem,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        items,
        listOrientation: 'standard',
        platformOS: 'ios',
        rendererKind: 'legendList',
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
        transcriptNativeHotTailItemCount: 0,
        transcriptWebHotTailItemCount: 0,
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
        autoPinDelayMs: 1000,
        closeEntryViewportOwnership: vi.fn(),
        committedMessagesCount: 5,
        composerInsetHeightRef: { current: 0 },
        currentSessionIdRef: { current: 's1' },
        decomposedItems: items,
        displayItemsLength: 1,
        disposeEntryRestoreTransactionForExitRef: { current: () => {} },
        entryRestoreDeadlineTimeoutRef: { current: null },
        entryRestoreOwner: createEntryRestoreOwner(),
        entrySliceWindowRef: { current: null },
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => true),
        initialBottomPositionOwner: 'app' as const,
        initialFillAbortRef: { current: null },
        initialWebPinStabilizingRef: { current: false },
        invalidateViewportAnchorCapture: vi.fn(),
        isLoaded: true,
        isScrollable,
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        jumpToSeq: null,
        jumpToSeqActiveRef: { current: false },
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
        pinToBottom: vi.fn(() => true),
        pinToBottomRespectingNativeMountSettle: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        recordEntryOwnerOutcome: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        rendererKind: 'flashList',
        renderWindowProjection,
        requestBottomFollowScheduledWriteRef: { current: () => {} },
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
        revealEntrySliceWindow: vi.fn(() => 0),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        scheduleFirstSessionOpenWebInitialPinRetryRef: { current: null },
        sessionEntryViewportRef: { current: null as SessionEntryViewportRefValue },
        sessionId: 's1',
        sessionOpenLatch,
        sessionOpenWebInitialPinRetryArmAtMsRef: { current: 0 },
        sessionOpenWebInitialPinRetryTimeoutRef: { current: null },
        setEntrySliceWindow: vi.fn(),
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        waitForNextVisualUpdate: vi.fn(async () => {}),
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
     * The web open contract has TWO halves, and asserting only the first one is what let an
     * unreachable-backfill state look correct:
     *   1. settlement must not wait for history (the latency win), and
     *   2. the transcript must still reach scrollability (the reachability guarantee),
     *      because `olderPaginationMachine` cannot arm while `scrollable === false` — under
     *      `scroll`, `edge-reached` AND `layout-committed` alike. Proved by execution in
     *      `pagination/olderPaginationMachine.underfilledWeb.test.ts`.
     * Settling first and filling after satisfies both: the fill costs zero open latency.
     */
    it('settles web session open WITHOUT waiting for history: zero loads, zero elapsed ms', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });
        const openedAtMs = Date.now();

        // Instrument the TRANSITION, not a later poll: `renderHook` drains microtasks, so by
        // the time an external loop runs the post-settle fill has already advanced the clock.
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

        // Zero history loads and zero elapsed simulated ms at the moment the open settled:
        // the post-settle fill costs the open nothing.
        expect(settleObservation.value?.loads).toBe(0);
        expect(settleObservation.value!.atMs - openedAtMs).toBe(0);
    });

    it('web still reaches a scrollable transcript, so the older pager can arm at all', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        // The realistic tool-heavy tail: the newest page is collapsed tool calls and
        // sidechain-routed raw events that add NO main-lane height, so the first paint is
        // shorter than the viewport. Growth only arrives on later pages.
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

        expect(harness.listContentHeightRef.current).toBe(700);
    });

    it('web post-settle fill preserves the prepend viewport (older rows must not move the reader)', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [250, 250],
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.loadOlder).toHaveBeenCalled();
        }, { timeout: 5000 });

        // The open-phase loop uses `preservePrependViewport: false` because it is pinned to
        // bottom. After settlement the reader owns the viewport, so every load must preserve it.
        // The harness mock declares no parameters, so vitest types its recorded calls as `[]`.
        // Read them through the real argument shape to assert what the host actually passed.
        const recordedCalls = harness.loadOlder.mock.calls as unknown as ReadonlyArray<
            readonly [Readonly<{ preservePrependViewport?: boolean }>]
        >;
        expect(recordedCalls.length).toBeGreaterThan(0);
        for (const call of recordedCalls) {
            expect(call[0]).toMatchObject({ preservePrependViewport: true });
        }
    });

    it('web post-settle fill stops at the absolute ceiling when every page adds only a sliver', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        // The case the no-progress counter CANNOT catch: each page adds a couple of px, so
        // progress resets the counter every iteration. Without an absolute ceiling this pages
        // the entire session to cross one viewport — a request + decrypt + render each time.
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: Array.from({ length: 400 }, () => 2),
            loadDurationMs: 700,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.loadOlder.mock.calls.length).toBeGreaterThanOrEqual(2);
        }, { timeout: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Derived from the SAME owner the implementation reads, so the bound cannot drift
        // apart from it: the absolute ceiling is budgetMs * 5 of simulated time, and the
        // harness advances that clock by loadDurationMs per load.
        const { budgetMs } = resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: sync.getSyncTuning().transcriptInitialFillBudgetMs,
            transcriptInitialFillMaxNoProgressLoads: sync.getSyncTuning().transcriptInitialFillMaxNoProgressLoads,
        });
        const maxLoadsUnderCeiling = Math.ceil((budgetMs * 5) / 700) + 1;
        expect(harness.loadOlder.mock.calls.length).toBeLessThanOrEqual(maxLoadsUnderCeiling);
        // The point of the ceiling: nowhere near the 400 pages the session could supply.
        expect(harness.loadOlder.mock.calls.length).toBeLessThan(50);
        expect(harness.isScrollable()).toBe(false);
    });

    it('web post-settle fill gives up on a run of zero-growth pages instead of fetching forever', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const harness = createFillHarness({
            layoutHeightPx: 600,
            initialContentHeightPx: 200,
            contentGrowthPerLoadPx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            loadDurationMs: 100,
            hasMoreAfterPlan: true,
        });

        await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: harness.deps },
        );
        await vi.waitFor(() => {
            expect(harness.loadOlder.mock.calls.length).toBeGreaterThanOrEqual(3);
        }, { timeout: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Bounded: 3 consecutive no-progress loads stop it. Never scrollable, but also
        // never an unbounded fetch loop.
        expect(harness.loadOlder.mock.calls.length).toBeLessThanOrEqual(4);
        expect(harness.isScrollable()).toBe(false);
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

    it('settles the latch even when a fill load rejects (no eternal open-pin authority)', async () => {
        // Live capture 2026-07-20 (web): a fill that died without settling left the
        // latch in 'positioning' forever; the host then re-executed the initial-open
        // pin on every content tick — 72 `initial-open` writes fought a 16-step user
        // upscroll a full minute after the open. Every terminal path of the fill
        // executor — completion, abort, or failure — must settle the latch.
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

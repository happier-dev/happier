/**
 * Fallback guard regression test for the web anchor restore path.
 *
 * Defect (P2SMOKE2-P5): when switching back to a session after a jump-class restore (seq=41,
 * anchor offsetY≈26835), the entry host fired the distance-from-bottom fallback on fresh mount
 * while scrollHeight was still 0. Because listDataRef was empty (FlashList not yet rendered),
 * the hot-tail guard inside performWebDomVisibleAnchorRestoreCommand returned not_found without
 * calling scrollToIndex. The fallback then wrote scrollTop=0 via writeWebScrollTopAndObserve,
 * observeWeb({status:'aligned'}) closed the transaction with lastClosedSessionId set, and all
 * future restore attempts were permanently blocked — leaving the viewport stuck at st=0.
 *
 * Fix: gate the fallback on
 *   max(0, scrollHeight - clientHeight) >= fallbackDistancePx
 * When scrollHeight=0, maxScrollTop=0 < 26835 → skip fallback → markInitialCommandFailed
 * (no closedSessionId) → transaction retryable on next listDataLength/listContentHeight change.
 *
 * Contract pinned here: "restore-with-unmounted-anchor must materialize/wait, not no-op to top."
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { SessionEntryViewportRefValue } from './useTranscriptEntryHost';
import { useTranscriptEntryHost } from './useTranscriptEntryHost';

const syncMockState = vi.hoisted(() => ({
    sessionViewport: null as null | {
        anchor: null;
        isPinned: boolean;
        lastUpdatedAt: number;
        offsetY: number;
        source: 'default' | 'observed';
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionViewport: () => syncMockState.sessionViewport,
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

function createStableMembers(overrides?: {
    entryRestoreOwner?: ReturnType<typeof createEntryRestoreOwner>;
    executeViewportCommand?: (command: unknown) => boolean;
    items?: readonly ChatTranscriptListItem[];
    lastScrollOffsetForIntentRef?: { current: number | null };
    restoreWebViewportAnchorThroughViewportCommand?: EntryHostDeps['restoreWebViewportAnchorThroughViewportCommand'];
    resolveWebScrollMetrics?: () => WebTranscriptScrollMetrics | null;
    sessionEntryViewportRef?: { current: SessionEntryViewportRefValue };
}) {
    const items: readonly ChatTranscriptListItem[] = overrides?.items ?? [];
    const renderWindowProjection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
        activeThinkingMessageId: null,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        items,
        listOrientation: 'standard',
        platformOS: 'ios',
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
    return {
        anchorLookupExhaustedRef: { current: false },
        anchorLookupInFlightRef: { current: false },
        anchorLookupLoadCountRef: { current: 0 },
        applyEntryRestoreOwnerEffectsRef: { current: () => {} },
        applySessionOpenArmResetPlan: vi.fn(),
        applySessionOpenDisposeResetPlan: vi.fn(),
        applySessionOpenLatchEffectsRef: { current: () => {} },
        attemptEntryRestoreRef: { current: () => {} },
        closeEntryViewportOwnership: vi.fn(),
        composerInsetHeightRef: { current: 0 },
        currentSessionIdRef: { current: 's1' },
        decomposedItems: items,
        disposeEntryRestoreTransactionForExitRef: { current: () => {} },
        entryRestoreDeadlineTimeoutRef: { current: null },
        entryRestoreOwner: overrides?.entryRestoreOwner ?? createEntryRestoreOwner(),
        entrySliceWindowRef: { current: null },
        executeViewportCommand: overrides?.executeViewportCommand ?? vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        initialFillAbortRef: { current: null },
        initialWebPinStabilizingRef: { current: false },
        invalidateViewportAnchorCapture: vi.fn(),
        isScrollable: vi.fn(() => false),
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        jumpToSeqActiveRef: { current: false },
        lastScrollOffsetForIntentRef: overrides?.lastScrollOffsetForIntentRef ?? { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        latestJumpToSeqRef: { current: null },
        listContentHeightRef: { current: 0 },
        listDataRef: { current: items },
        listLayoutHeightRef: { current: 0 },
        listRef: { current: null },
        loadOlder: vi.fn(async () => null),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleDeadlineReachedRef: { current: false },
        observeMountSettleMetrics: vi.fn(),
        pinToBottom: vi.fn(() => true),
        pinToBottomRespectingNativeMountSettle: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        renderWindowProjection,
        requestBottomFollowScheduledWriteRef: { current: () => {} },
        resolveEntryRestoreOwnerAnchor: vi.fn<EntryHostDeps['resolveEntryRestoreOwnerAnchor']>(() => null),
        resolveNearestSurvivingViewportAnchorIndex: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndex']>(() => null),
        resolveNearestSurvivingViewportAnchorIndexFromItems: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndexFromItems']>(() => null),
        resolveSeqForViewportAnchor: vi.fn(() => null),
        resolveViewportCommand: vi.fn(() => ({
            kind: 'none' as const,
            sessionId: 's1',
            reason: 'test',
            mode: 'hydrating' as const,
        })),
        resolveWebScrollMetrics: overrides?.resolveWebScrollMetrics ?? vi.fn(() => null),
        restoreWebViewportAnchorThroughViewportCommand: overrides?.restoreWebViewportAnchorThroughViewportCommand ?? vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        revealEntrySliceWindow: vi.fn(() => 0),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        scheduleFirstSessionOpenWebInitialPinRetryRef: { current: null },
        // Viewport recorded for session 's1' with offsetY = 26835 (a jump-class restore target).
        sessionEntryViewportRef: overrides?.sessionEntryViewportRef ?? {
            current: null,
        },
        sessionOpenLatch: createSessionOpenLatch(),
        sessionOpenWebInitialPinRetryArmAtMsRef: { current: 0 },
        sessionOpenWebInitialPinRetryTimeoutRef: { current: null },
        setEntrySliceWindow: vi.fn(),
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        waitForNextVisualUpdate: vi.fn(async () => {}),
        wantsPinnedRef: { current: true },
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): EntryHostDeps {
    return {
        ...members,
        autoPinDelayMs: 1000,
        committedMessagesCount: 0,
        displayItemsLength: 0,
        isLoaded: false,
        jumpToSeq: null,
        listContentHeight: 0,
        listDataLength: 0,
        listLayoutHeight: 0,
        pinThresholdPx: 32,
        sessionId: 's1',
    };
}

describe('useTranscriptEntryHost fallback guard', () => {
    beforeEach(() => {
        syncMockState.sessionViewport = null;
    });

    /**
     * This test reproduces the P2SMOKE2-P5 defect and pins the fix contract:
     *
     * When restoreWebViewportAnchorThroughViewportCommand returns not_found (hot-tail guard
     * fires on fresh mount with empty listData) AND the fallback offsetY target (26835 px)
     * is beyond the current maxScrollTop (scrollHeight=0 → maxScrollTop=0), the host MUST NOT
     * issue a viewport command. Writing scrollTop=0 via the unguarded path would close the
     * transaction with lastClosedSessionId set, permanently blocking future restore retries.
     *
     * After the guard is respected (scrollHeight grows to 46080 → maxScrollTop=45532 ≥ 26835),
     * the host MUST issue the fallback viewport command exactly once.
     */
    it('does not issue executeViewportCommand when fallback offsetY exceeds maxScrollTop, then does when content is rendered', async () => {
        // Simulate session entry viewport recorded with offsetY=26835 (jump-class anchor).
        const sessionEntryViewportRef: { current: SessionEntryViewportRefValue } = {
            current: {
                sessionId: 's1',
                entryKind: 'jump',
                shouldFollowBottom: false,
                offsetY: 26835,
                anchor: null,
                sourceLastUpdatedAt: 1000,
                effects: [],
            },
        };
        const executeViewportCommand = vi.fn(() => true);
        const resolveWebScrollMetrics = vi.fn(() => null as WebTranscriptScrollMetrics | null);

        const members = createStableMembers({
            executeViewportCommand,
            resolveWebScrollMetrics,
            sessionEntryViewportRef,
        });

        const hook = await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: buildDeps(members) },
        );

        const { applyEntryRestoreOwnerEffects } = hook.getCurrent();

        // Build the execute-command effect as the owner would produce it on a
        // restore-web-anchor-through-command path (anchor at seq/index 38).
        const executeCommandEffect = {
            type: 'execute-command' as const,
            command: {
                type: 'restore-web-anchor-through-command' as const,
                anchor: {
                    kind: 'message' as const,
                    itemId: 'msg-38',
                    index: 38,
                    messageId: null,
                    itemOffsetPx: 0,
                    seq: 38,
                },
                itemIndex: 38,
                sessionId: 's1',
            },
        };

        const fakeElement = {} as HTMLElement;

        // PHASE 1: scrollHeight=0 (fresh mount, content not yet rendered).
        // maxScrollTop = max(0, 0 - 548) = 0 < fallbackDistancePx=26835 → guard blocks.
        resolveWebScrollMetrics.mockReturnValue({ element: fakeElement, scrollTop: 0, scrollHeight: 0, clientHeight: 548 });
        applyEntryRestoreOwnerEffects([executeCommandEffect]);

        expect(executeViewportCommand).not.toHaveBeenCalled();

        // PHASE 2: scrollHeight=46080 (content rendered past target depth).
        // maxScrollTop = max(0, 46080 - 548) = 45532 ≥ 26835 → guard passes.
        resolveWebScrollMetrics.mockReturnValue({ element: fakeElement, scrollTop: 0, scrollHeight: 46080, clientHeight: 548 });
        applyEntryRestoreOwnerEffects([executeCommandEffect]);

        expect(executeViewportCommand).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('does not replay an anchored web entry restore after an accepted scroll observation', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-1',
            itemId: 'msg:message-1',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 10,
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:message-1',
            messageId: 'message-1',
            createdAt: 1000,
            seq: 10,
        }];
        const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
            didAdjustScroll: true,
            status: 'restored' as const,
            strategy: 'anchor' as const,
        }));
        const members = createStableMembers({
            items,
            lastScrollOffsetForIntentRef: { current: 10_472 },
            restoreWebViewportAnchorThroughViewportCommand,
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);
        members.isViewportAnchorSeqLoaded = vi.fn(() => true);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                    listDataRef: { current: items },
                }) },
            );

            expect(restoreWebViewportAnchorThroughViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('does not replay an anchored web entry restore after sync records a newer detached viewport', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        syncMockState.sessionViewport = {
            anchor: null,
            isPinned: false,
            lastUpdatedAt: 2000,
            offsetY: 2520,
            source: 'observed',
        };
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-1',
            itemId: 'msg:message-1',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 10,
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:message-1',
            messageId: 'message-1',
            createdAt: 1000,
            seq: 10,
        }];
        const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
            didAdjustScroll: true,
            status: 'restored' as const,
            strategy: 'anchor' as const,
        }));
        const members = createStableMembers({
            items,
            restoreWebViewportAnchorThroughViewportCommand,
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);
        members.isViewportAnchorSeqLoaded = vi.fn(() => true);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                    listDataRef: { current: items },
                }) },
            );

            expect(restoreWebViewportAnchorThroughViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('clears a pending web initial-pin retry when the host unmounts', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const members = createStableMembers();

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                {
                    initialProps: {
                        ...buildDeps(members),
                        isLoaded: true,
                    },
                },
            );

            expect(members.sessionOpenWebInitialPinRetryTimeoutRef.current).not.toBeNull();
            expect(vi.getTimerCount()).toBeGreaterThan(0);

            await hook.unmount();

            expect(members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });


    it('preempts an open web entry transaction before correction writes after an accepted scroll observation', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const entryRestoreOwner = createEntryRestoreOwner();
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:distance-sentinel',
            messageId: 'distance-sentinel',
            createdAt: 1000,
            seq: 9,
        }];
        const openEffects = entryRestoreOwner.attempt<ChatTranscriptListItem>({
            canMaterializeOlder: false,
            contentHeight: 20_000,
            currentSessionId: 's1',
            deadlineMs: 1000,
            exactAnchorIndex: null,
            fillSettled: true,
            items,
            jumpToSeqActive: false,
            layoutHeight: 670,
            nearestAnchorIndex: null,
            nowMs: 1000,
            platform: 'web',
            restoredViewport: {
                anchor: null,
                offsetY: 2520,
                sessionId: 's1',
                shouldFollowBottom: false,
            },
            slice: { capable: false },
            userScrollObserved: false,
        });
        expect(openEffects.some((effect) => effect.type === 'execute-command')).toBe(true);

        const executeViewportCommand = vi.fn(() => true);
        const fakeElement = {} as HTMLElement;
        const members = createStableMembers({
            entryRestoreOwner,
            executeViewportCommand,
            items,
            lastScrollOffsetForIntentRef: { current: 15_996 },
            resolveWebScrollMetrics: vi.fn(() => ({
                clientHeight: 670,
                element: fakeElement,
                scrollHeight: 20_544,
                scrollTop: 15_996,
            })),
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor: null,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps(members) },
            );

            expect(executeViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});

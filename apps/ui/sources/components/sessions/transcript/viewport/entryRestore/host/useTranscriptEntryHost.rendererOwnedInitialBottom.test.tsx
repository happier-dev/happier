/**
 * Legend is the dev transcript's sole initial-bottom positioning owner. The mounted app
 * host may publish load/layout/fill facts, but it must never write or schedule a competing
 * initial pin across layout and passive commits.
 */
import { describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { SessionEntryViewportRefValue } from './useTranscriptEntryHost';
import { useTranscriptEntryHost } from './useTranscriptEntryHost';

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

function createEnvelopeHarness() {
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

    // At-bottom metrics: the open transaction verifies aligned and closes immediately,
    // matching the live warm scrollable session where the storm was captured.
    const metrics: WebTranscriptScrollMetrics = {
        element: {} as unknown as WebTranscriptScrollMetrics['element'],
        scrollTop: 45532,
        scrollHeight: 46080,
        clientHeight: 548,
    };

    const sessionOpenLatch = createSessionOpenLatch();
    sessionOpenLatch.arm({
        entryKind: 'bottom',
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs: Date.now(),
        platform: 'web',
        sessionId: 's1',
        shouldFollowBottom: true,
        webOpenPhaseDeadlineDelayMs: 30_000,
    });

    const pinToBottom = vi.fn(() => true);
    const members = {
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
        composerInsetHeightRef: { current: 0 },
        currentSessionIdRef: { current: 's1' },
        decomposedItems: items,
        disposeEntryRestoreTransactionForExitRef: { current: () => {} },
        entryRestoreDeadlineTimeoutRef: { current: null },
        entryRestoreOwner: createEntryRestoreOwner(),
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        initialFillAbortRef: { current: null },
        invalidateViewportAnchorCapture: vi.fn(),
        isScrollable: vi.fn(() => true),
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        lastScrollOffsetForIntentRef: { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        latestJumpToSeqRef: { current: null },
        listContentHeightRef: { current: 46080 },
        listDataRef: { current: items },
        listLayoutHeightRef: { current: 548 },
        listRef: { current: null },
        loadOlder: vi.fn(async () => null),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleDeadlineReachedRef: { current: false },
        nativeMountSettleStable: false,
        observeMountSettleMetrics: vi.fn(),
        pinToBottom,
        pinToBottomRespectingNativeMountSettle: vi.fn(),
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
        resolveWebScrollMetrics: vi.fn(() => metrics),
        restoreWebViewportAnchorThroughViewportCommand: vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        sessionEntryViewportRef: { current: null as SessionEntryViewportRefValue },
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        wantsPinnedRef: { current: true },
    };

    const buildDeps = (overrides?: Partial<EntryHostDeps>): EntryHostDeps => ({
        ...members,
        committedMessagesCount: 5,
        displayItemsLength: 3,
        isLoaded: true,
        jumpToSeq: null,
        listContentHeight: 46080,
        listDataLength: 3,
        listLayoutHeight: 548,
        pinThresholdPx: 32,
        sessionId: 's1',
        ...overrides,
    });

    return { buildDeps, members, pinToBottom, sessionOpenLatch };
}

describe('useTranscriptEntryHost renderer-owned initial bottom', () => {
    it('never app-pins or schedules retry timers across load, layout, passive commits, and unmount', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();
        try {
            const harness = createEnvelopeHarness();
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                {
                    initialProps: harness.buildDeps({
                        isLoaded: false,
                        listContentHeight: 0,
                        listDataLength: 0,
                        listLayoutHeight: 0,
                    }),
                },
            );

            const assertNoAppInitialBottomAuthority = () => {
                expect(harness.pinToBottom).not.toHaveBeenCalled();
                expect(harness.members.pinToBottomRespectingNativeMountSettle).not.toHaveBeenCalled();
                expect(harness.members.executeViewportCommand).not.toHaveBeenCalled();
                expect(vi.getTimerCount()).toBe(0);
            };

            assertNoAppInitialBottomAuthority();
            await hook.rerender(harness.buildDeps({
                isLoaded: true,
                listContentHeight: 0,
                listDataLength: 3,
                listLayoutHeight: 0,
            }));
            assertNoAppInitialBottomAuthority();

            await hook.rerender(harness.buildDeps());
            assertNoAppInitialBottomAuthority();

            await hook.rerender(harness.buildDeps({
                recordViewportTelemetryEvent: vi.fn(),
            }));
            assertNoAppInitialBottomAuthority();

            await hook.unmount();
            assertNoAppInitialBottomAuthority();
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});

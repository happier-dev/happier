/**
 * Web initial-pin retry chain: bounded by the session-open stabilize envelope.
 *
 * Live capture 2026-07-20 (web, heavy session at rest): the retry chain restarted forever
 * after the open completed. The restart effect re-armed the chain on any render with no
 * pending retry handle, the timeout body rescheduled the next retry unconditionally (even
 * after a completed attempt), and every restart replayed the whole retry plan against the
 * minutes-old arm timestamp — all deadlines already past, so the plan fired as an immediate
 * burst of `pinToBottom('initial-open')` writes (~2Hz bursts, 243 no-op writes observed).
 * Each write fed scroll observation -> state churn -> re-render -> restart: self-sustaining.
 * Under composer typing/resize the same storm fought the renderer's stale end re-assertion,
 * producing the visible 102px transcript vibration.
 *
 * Contract pinned here: the chain's whole life is the open stabilize envelope
 * (`armAtMs + stabilizeMaxMs`, the same bound the web bottom-entry transaction uses).
 * Inside the envelope retries stabilize the open pin; past it, nothing may schedule or
 * fire an initial-open pin again.
 */
import { describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type { SessionOpenInitialBottomPositionOwner } from '@/components/sessions/transcript/viewport/sessionOpen/types';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { TranscriptListRendererKind } from '@/components/sessions/transcript/viewport/shell/renderer/types';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
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

function createEnvelopeHarness(params: Readonly<{
    initialBottomPositionOwner: SessionOpenInitialBottomPositionOwner;
    rendererKind: TranscriptListRendererKind;
}>) {
    const items: readonly ChatTranscriptListItem[] = [];
    const renderWindowProjection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
        activeThinkingMessageId: null,
        createWindowGapItem: createTranscriptWindowGapItem,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        items,
        listOrientation: 'standard',
        platformOS: 'web',
        rendererKind: params.rendererKind,
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
        initialBottomPositionOwner: params.initialBottomPositionOwner,
        isNativeFlashListBottomMaintenanceEnabled: false,
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs: Date.now(),
        platform: 'web',
        sessionId: 's1',
        shouldFollowBottom: true,
        webInitialPinRetryDelaysMs: [16, 50, 100, 200, 400, 800],
        webInitialPinStabilizeMs: 3000,
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
        entrySliceWindowRef: { current: null },
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        initialBottomPositionOwner: params.initialBottomPositionOwner,
        initialFillAbortRef: { current: null },
        initialWebPinStabilizingRef: { current: false },
        invalidateViewportAnchorCapture: vi.fn(),
        isScrollable: vi.fn(() => true),
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        isViewportNearOlderEdge: vi.fn(() => false),
        jumpToSeqActiveRef: { current: false },
        lastScrollOffsetForIntentRef: { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        userScrollIntent: createTranscriptUserScrollIntentOwner(),
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
        rendererKind: params.rendererKind,
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
        resolveWebScrollMetrics: vi.fn(() => metrics),
        restoreWebViewportAnchorThroughViewportCommand: vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        revealEntrySliceWindow: vi.fn(() => 0),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        scheduleFirstSessionOpenWebInitialPinRetryRef: { current: null },
        sessionEntryViewportRef: { current: null as SessionEntryViewportRefValue },
        sessionOpenLatch,
        sessionOpenWebInitialPinRetryArmAtMsRef: { current: Date.now() },
        sessionOpenWebInitialPinRetryTimeoutRef: { current: null },
        setEntrySliceWindow: vi.fn(),
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        waitForNextVisualUpdate: vi.fn(async () => {}),
        wantsPinnedRef: { current: true },
    };
    const onHostFacts = vi.spyOn(sessionOpenLatch, 'onHostFacts');

    const buildDeps = (overrides?: Partial<EntryHostDeps>): EntryHostDeps => ({
        ...members,
        autoPinDelayMs: 1000,
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

    return { buildDeps, members, onHostFacts, pinToBottom, sessionOpenLatch };
}

describe('useTranscriptEntryHost web initial-pin retry envelope', () => {
    it('submits one host-facts effect and issues no app pin or retry for renderer-owned Legend entry', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();
        try {
            const harness = createEnvelopeHarness({
                initialBottomPositionOwner: 'renderer',
                rendererKind: 'legendList',
            });
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: harness.buildDeps({ isLoaded: false }) },
            );

            expect(harness.onHostFacts).toHaveBeenCalledTimes(1);
            expect(harness.pinToBottom).not.toHaveBeenCalled();
            expect(harness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);

            await hook.rerender(harness.buildDeps({
                isLoaded: true,
                isScrollable: () => false,
            }));
            expect(harness.onHostFacts).toHaveBeenCalledTimes(2);
            expect(harness.pinToBottom).not.toHaveBeenCalled();
            expect(harness.members.pinToBottomRespectingNativeMountSettle).not.toHaveBeenCalled();
            expect(harness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);

            await hook.rerender(harness.buildDeps({
                displayItemsLength: 4,
                isLoaded: true,
                isScrollable: () => true,
                listContentHeight: 47_000,
                listDataLength: 4,
            }));
            await vi.advanceTimersByTimeAsync(5_000);

            expect(harness.onHostFacts).toHaveBeenCalledTimes(3);
            expect(harness.pinToBottom).not.toHaveBeenCalled();
            expect(harness.members.pinToBottomRespectingNativeMountSettle).not.toHaveBeenCalled();
            expect(harness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('never schedules or fires an initial-open pin past the open stabilize envelope', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();
        try {
            const harness = createEnvelopeHarness({
                initialBottomPositionOwner: 'app',
                rendererKind: 'flashList',
            });
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: harness.buildDeps() },
            );

            // Sanity: the open itself pins (warm scrollable bottom entry completes the
            // phase immediately, but the initial pin request still runs at mount).
            expect(harness.pinToBottom).toHaveBeenCalledWith('initial-open');
            expect(harness.sessionOpenLatch.phase()).toBe('done');

            // Let the whole stabilize envelope (3000ms) plus the retry tail elapse.
            await vi.advanceTimersByTimeAsync(5_000);

            // A later render with churned callback identities (the live storm trigger:
            // any state update re-renders the host with fresh callbacks and an empty
            // retry handle). Nothing about the open is pending anymore.
            const latePinToBottom = vi.fn<EntryHostDeps['pinToBottom']>(() => true);
            await hook.rerender(harness.buildDeps({ pinToBottom: latePinToBottom }));
            await vi.advanceTimersByTimeAsync(2_000);
            const lateInitialOpenPins = latePinToBottom.mock.calls.filter(
                (call) => call[0] === 'initial-open',
            );
            expect(lateInitialOpenPins).toHaveLength(0);

            // And repeated render churn must not accumulate writes either (live: ~2Hz
            // bursts forever).
            const stormPinToBottom = vi.fn<EntryHostDeps['pinToBottom']>(() => true);
            await hook.rerender(harness.buildDeps({ pinToBottom: stormPinToBottom }));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(
                stormPinToBottom.mock.calls.filter((call) => call[0] === 'initial-open'),
            ).toHaveLength(0);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('retains the Flash retry and clears it on disposal and unmount', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();
        try {
            const disposedHarness = createEnvelopeHarness({
                initialBottomPositionOwner: 'app',
                rendererKind: 'flashList',
            });
            const disposedHook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: disposedHarness.buildDeps() },
            );

            expect(disposedHarness.pinToBottom).toHaveBeenCalledWith('initial-open');
            expect(disposedHarness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).not.toBeNull();
            expect(vi.getTimerCount()).toBeGreaterThan(0);

            disposedHook.getCurrent().applySessionOpenLatchEffects(
                disposedHarness.sessionOpenLatch.disarm({
                    reason: 'disposed',
                    sessionId: 's1',
                }).effects,
            );
            expect(disposedHarness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
            await disposedHook.unmount();

            const unmountedHarness = createEnvelopeHarness({
                initialBottomPositionOwner: 'app',
                rendererKind: 'flashList',
            });
            const unmountedHook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: unmountedHarness.buildDeps() },
            );

            expect(unmountedHarness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).not.toBeNull();
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            await unmountedHook.unmount();
            expect(unmountedHarness.members.sessionOpenWebInitialPinRetryTimeoutRef.current).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});

/**
 * Identity-stability contract for the extracted bottom-follow host (M5 extraction guard).
 *
 * ChatList rebuilds the deps object literal passed to `useTranscriptBottomFollowHost` on every
 * render. The hook's callbacks must therefore depend on individual `deps.*` fields, never on the
 * whole deps object, or scheduler/pin callbacks churn and effects keyed on them can re-fire every
 * render.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptBottomFollowHost } from './useTranscriptBottomFollowHost';

type BottomFollowHostDeps = Parameters<typeof useTranscriptBottomFollowHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    return {
        applyFollowBottomIntentTakeoverApplyEffects: vi.fn(),
        applyNativeExplicitJumpConfirmationEffects: vi.fn(),
        authorizeImmediateBottomFollowWriteRef: createRef(() => false),
        canAutoFollowForReason: vi.fn(() => true),
        commitBottomFollowModeState: vi.fn(),
        commitExplicitReturnToLiveTailState: vi.fn(),
        commitScrollPinState: vi.fn(),
        currentBottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' as const }),
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => true),
        hasNativeInitialViewportAppliedForCurrentSession: vi.fn(() => false),
        hasRearmedNativeBottomFollow: vi.fn(() => false),
        invalidateViewportAnchorCapture: vi.fn(),
        isPinnedRef: createRef(true),
        lastNativePinOffsetRef: createRef<number | null>(null),
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lifecycleHost: {
            clearNativeExplicitJumpConfirmation: vi.fn(),
            getMountSettleSnapshot: vi.fn(() => ({ isMountSettleActive: false })),
            observeNativeScrollConfirmation: vi.fn(() => ({
                consumed: false,
                entrySettleEffects: [],
                explicitJumpEffects: [],
            })),
            planContentGrowthLiveTailCommand: vi.fn(() => ({
                contentGrowthLiveTailCommandEffect: {
                    reason: 'content-size-change' as const,
                    sessionId: 's1',
                    type: 'request-content-growth-live-tail-command' as const,
                },
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
            planFollowBottomIntentTakeover: vi.fn(() => ({
                followBottomIntentTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
            planMeasuredNativeLiveTailPin: vi.fn(() => ({ type: 'not-ready' as const })),
            planNativeMountSettlePendingPinFlush: vi.fn(() => ({ effects: [] })),
        },
        liveTailCarveTelemetry: {
            active: false,
            anchorId: null,
            anchorKind: null,
            coldCount: 0,
            hotCount: 0,
        },
        listContentHeightRef: createRef(0),
        listLayoutHeightRef: createRef(0),
        listRef: createRef(null),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleAutoPinSuppressedRef: createRef(false),
        nativeMountSettleDeadlineReachedRef: createRef(false),
        nativeHotTailHeightRef: createRef(0),
        observeNativeStreamAppendOffsetEscape: vi.fn(() => false),
        pinThresholdPxRef: createRef(72),
        readCurrentNativeDistanceFromBottom: vi.fn(() => 0),
        readViewportContentMetrics: vi.fn(() => ({ contentHeight: 1000, layoutHeight: 500 })),
        recordViewportTelemetryEvent: vi.fn(),
        requestBottomFollowScheduledWriteRef: createRef(() => {}),
        resolveViewportCommand: vi.fn((input: unknown) => input),
        resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
        resolveWebScrollMetrics: vi.fn(() => null),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        tryPinToBottomDom: vi.fn(() => false),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        wantsPinnedRef: createRef(true),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): BottomFollowHostDeps {
    return {
        ...members,
        followBottomIntentKey: null,
        latestCommittedActivityKey: 'activity-1',
        jumpToSeq: null,
        nativeHotTailResetRequired: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        sessionId: 's1',
        usesNativeFlashListBottomMaintenance: true,
    } as unknown as BottomFollowHostDeps;
}

describe('useTranscriptBottomFollowHost identity stability', () => {
    it('keeps host callbacks referentially stable across re-renders with fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: BottomFollowHostDeps) => useTranscriptBottomFollowHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();
        const firstRequestScheduled = members.requestBottomFollowScheduledWriteRef.current;

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.captureNativeBottomFollowPreviousFollow).toBe(first.captureNativeBottomFollowPreviousFollow);
        expect(second.captureWebBottomFollowPreviousMetrics).toBe(first.captureWebBottomFollowPreviousMetrics);
        expect(second.pinNativeInitialFollowBottomViewportIfReady).toBe(first.pinNativeInitialFollowBottomViewportIfReady);
        expect(second.pinToBottom).toBe(first.pinToBottom);
        expect(second.pinToBottomRespectingNativeMountSettle).toBe(first.pinToBottomRespectingNativeMountSettle);
        expect(second.requestAutomaticLiveTailPin).toBe(first.requestAutomaticLiveTailPin);
        expect(second.requestMeasuredNativeAutomaticLiveTailPin).toBe(first.requestMeasuredNativeAutomaticLiveTailPin);
        expect(second.deferPinToBottomAfterScroll).toBe(first.deferPinToBottomAfterScroll);
        expect(second.cancelScheduledPinToBottom).toBe(first.cancelScheduledPinToBottom);
        expect(second.applyNativeDragActiveMirrorEffects).toBe(first.applyNativeDragActiveMirrorEffects);
        expect(members.requestBottomFollowScheduledWriteRef.current).toBe(firstRequestScheduled);

        await hook.unmount();
    });
});

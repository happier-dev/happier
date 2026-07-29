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
        authorizeImmediateBottomFollowWriteRef: createRef(vi.fn(() => false)),
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
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lifecycleHost: {
            clearNativeExplicitJumpConfirmation: vi.fn(),
            getMountSettleSnapshot: vi.fn(() => ({ isMountSettleActive: false })),
            observeNativeScrollConfirmation: vi.fn<BottomFollowHostDeps['lifecycleHost']['observeNativeScrollConfirmation']>(() => ({
                consumed: false,
                entrySettleEffects: [],
                explicitJumpEffects: [],
            })),
            planFollowBottomIntentTakeover: vi.fn(() => ({
                followBottomIntentTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
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
        nativeMountSettleDeadlineReachedRef: createRef(false),
        nativeHotTailHeightRef: createRef(0),
        pinThresholdPxRef: createRef(72),
        readCurrentNativeDistanceFromBottom: vi.fn(() => 0),
        readViewportContentMetrics: vi.fn(() => ({ contentHeight: 1000, layoutHeight: 500 })),
        recordViewportTelemetryEvent: vi.fn(),
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
    } as unknown as BottomFollowHostDeps;
}

describe('useTranscriptBottomFollowHost identity stability', () => {
    it('installs the renderer tail before publishing accepted own-send follow state', async () => {
        const members = createStableMembers();
        const order: string[] = [];
        members.tryPinToBottomDom.mockImplementation(() => {
            order.push('renderer-held-end');
            return true;
        });
        members.executeViewportCommand.mockImplementation(() => {
            order.push('renderer-held-end');
            return true;
        });
        members.commitExplicitReturnToLiveTailState.mockImplementation(() => {
            order.push('semantic-following');
        });
        const deps = buildDeps(members);
        const hook = await renderHook(
            (nextDeps: BottomFollowHostDeps) => useTranscriptBottomFollowHost(nextDeps),
            { initialProps: deps },
        );

        await hook.rerender({
            ...deps,
            followBottomIntentKey: 1,
        });

        expect(order).toEqual([
            'renderer-held-end',
            'semantic-following',
        ]);
        await hook.unmount();
    });

    it('consumes native entry-settle confirmation without issuing an app follow writer', async () => {
        const members = createStableMembers();
        members.lifecycleHost.observeNativeScrollConfirmation.mockReturnValue({
            consumed: true,
            entrySettleEffects: [{
                sessionId: 's1',
                type: 'issue-entry-settle-reconfirm-pin',
            }],
            explicitJumpEffects: [],
        });
        const deps = buildDeps(members);
        const hook = await renderHook(
            (nextDeps: BottomFollowHostDeps) => useTranscriptBottomFollowHost(nextDeps),
            { initialProps: deps },
        );

        hook.getCurrent().observeNativeConfirmation({
            contentHeight: 1000,
            distanceFromBottom: 0,
            isTrusted: false,
            mountSettleStable: true,
        });

        expect(members.executeViewportCommand).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps host callbacks referentially stable across re-renders with fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: BottomFollowHostDeps) => useTranscriptBottomFollowHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.pinToBottom).toBe(first.pinToBottom);
        expect(second.observeNativeConfirmation).toBe(first.observeNativeConfirmation);
        expect(second.beginExplicitJumpWriteBarrier).toBe(first.beginExplicitJumpWriteBarrier);
        expect(second.endExplicitJumpWriteBarrier).toBe(first.endExplicitJumpWriteBarrier);
        expect(second.applyNativeDragActiveMirrorEffects).toBe(first.applyNativeDragActiveMirrorEffects);

        await hook.unmount();
    });
});

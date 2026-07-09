import { describe, expect, it } from 'vitest';

import {
    createTranscriptLifecycleHost,
    type TranscriptLifecycleHostMeasuredNativePinInput,
} from './lifecycleHost';

const escapingBottomFollowState = {
    dragSession: {
        latestDistanceFromBottom: 96,
        returnedToBottom: false,
        sawAwayMovement: true,
        trusted: true,
    },
    mode: 'escaping',
} as const;

const measuredPinInput = (
    overrides: Partial<TranscriptLifecycleHostMeasuredNativePinInput> = {},
): TranscriptLifecycleHostMeasuredNativePinInput => ({
    autoPinDelayMs: 250,
    canAutoFollow: true,
    contentHeight: 2400,
    deferInitialViewportAppliedUntilObserved: false,
    forceMountSettle: false,
    force: false,
    hasContentMeasurement: true,
    hasInitialViewportApplied: true,
    hasRearmedBottomFollow: true,
    bottomFollowMode: 'following',
    distanceFromBottom: 144,
    forceFollowPin: false,
    isExplicitNativeCommand: false,
    isJumpToSeqActive: false,
    isMountSettleActive: false,
    lastNativePinOffset: null,
    lastStreamAppendPin: null,
    lastUserScrollIntentAtMs: 0,
    layoutHeight: 800,
    materializationAutoPin: null,
    mountSettleDeadlineReached: false,
    nativeAutomaticBottomPinCommandSessionId: null,
    nativeMountSettleStable: true,
    nowMs: 1000,
    pendingMountSettleBottomPin: false,
    pinThresholdPx: 72,
    reason: 'content-size-change',
    sessionId: 'session-a',
    shouldMarkInitialViewportApplied: false,
    usesNativeFlashListBottomMaintenance: true,
    wantsPinned: true,
    ...overrides,
});

describe('transcript lifecycle host', () => {
    it('groups explicit jump takeover effects in lifecycle order', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.planExplicitJumpTakeover({
            reason: 'jump-to-seq',
            sessionId: 'session-a',
        });

        expect(plan.explicitJumpTakeoverEffects.map((effect) => effect.type)).toEqual([
            'explicit-jump-cancel-native-mount-settle-bottom-pin',
            'explicit-jump-suppress-entry-restore',
            'explicit-jump-preempt-entry-restore',
            'explicit-jump-clear-native-entry-restore-paint-release-timeout',
            'explicit-jump-invalidate-native-prepend-transaction',
            'explicit-jump-clear-native-restore-index-command-cache',
        ]);
        expect(plan.lifecycleEffects).toEqual(plan.explicitJumpTakeoverEffects);
    });

    it('groups explicit return and follow-bottom intent takeover effects', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const returnPlan = host.planExplicitReturnToLiveTail({
            intent: 'jump-to-bottom',
            sessionId: 'session-a',
        });
        const followIntentPlan = host.planFollowBottomIntentTakeover({ sessionId: 'session-a' });

        expect(returnPlan.viewportEffects).toEqual([{
            distanceFromLiveTailPx: 0,
            isPinned: true,
            sessionId: 'session-a',
            type: 'apply-explicit-return-to-live-tail-viewport',
        }]);
        expect(returnPlan.explicitReturnEffects).toEqual([
            {
                sessionId: 'session-a',
                type: 'apply-explicit-return-clear-user-scroll-intent',
            },
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                sessionId: 'session-a',
                type: 'apply-explicit-return-to-live-tail-viewport',
            },
        ]);
        expect(followIntentPlan.followBottomIntentTakeoverEffects.map((effect) => effect.type)).toEqual([
            'follow-bottom-intent-preempt-entry-restore',
            'follow-bottom-intent-clear-user-scroll-intent',
            'follow-bottom-intent-record-live-tail-pin-offset',
        ]);
    });

    it('groups local interaction auto-pin deferral effects for the current session', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.planLocalInteractionAutoPinDeferral({
            sessionId: 'session-a',
            timestampMs: 1234,
        });

        expect(plan.localInteractionAutoPinDeferralEffects).toEqual([
            {
                sessionId: 'session-a',
                timestampMs: 1234,
                type: 'local-interaction-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                type: 'local-interaction-suppress-native-mount-settle-auto-pin',
            },
            {
                sessionId: 'session-a',
                type: 'local-interaction-cancel-scheduled-pin',
            },
        ]);
    });

    it('plans content-growth live-tail commands and ignores stale sessions', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const stalePlan = host.planContentGrowthLiveTailCommand({
            reason: 'content-size-change',
            sessionId: 'session-b',
            wantsLiveTail: true,
        });
        const currentPlan = host.planContentGrowthLiveTailCommand({
            reason: 'content-size-change',
            sessionId: 'session-a',
            wantsLiveTail: true,
        });

        expect(stalePlan.lifecycleEffects).toEqual([]);
        expect(stalePlan.contentGrowthLiveTailCommandEffect).toBeNull();
        expect(currentPlan.lifecycleEffects).toEqual([{
            command: {
                reason: 'content-size-change',
                type: 'scroll-to-live-tail',
            },
            sessionId: 'session-a',
            type: 'command',
        }]);
        expect(currentPlan.contentGrowthLiveTailCommandEffect).toEqual({
            reason: 'content-size-change',
            sessionId: 'session-a',
            type: 'apply-content-growth-live-tail-command',
        });
    });

    it('plans native stream-append offset escape release through the lifecycle owner', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const releasePlan = host.planNativeOffsetEscapeRelease({
            bottomFollowState: escapingBottomFollowState,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            timestampMs: 2000,
            wantsPinned: true,
        });

        expect(releasePlan.decision).toEqual({ type: 'release' });
        expect(releasePlan.nativeGestureTakeoverPlan).not.toBeNull();
        expect(releasePlan.lifecycleEffects.map((effect) => effect.type)).toContain('native-offset-release-live-tail');
        expect(releasePlan.nativeOffsetReleaseLiveTailStateEffects).toEqual([{
            bottomFollowState: releasePlan.state.bottomFollowState,
            sessionId: 'session-a',
            type: 'apply-native-offset-release-live-tail-state',
        }]);
        expect(releasePlan.state.bottomFollowState.mode).toBe('released');

        const blockedPlan = host.planNativeOffsetEscapeRelease({
            bottomFollowState: escapingBottomFollowState,
            distanceFromLiveTailPx: 48,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            timestampMs: 2016,
            wantsPinned: true,
        });

        expect(blockedPlan.decision).toEqual({
            reason: 'inside-pin-threshold',
            type: 'blocked',
        });
        expect(blockedPlan.nativeGestureTakeoverPlan).toBeNull();
        expect(blockedPlan.lifecycleEffects).toEqual([]);
        expect(blockedPlan.nativeOffsetReleaseLiveTailStateEffects).toEqual([]);
    });

    it('owns native confirmation pending state and preserves explicit-first ordering', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        host.armNativeExplicitJumpConfirmation({
            issuedContentHeight: 1200,
            sessionId: 'session-a',
        });
        host.armNativeEntrySettleConfirmation({
            baselineContentHeight: 1200,
            sessionId: 'session-a',
        });

        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1500,
            distanceFromBottom: 180,
            isTrusted: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [
                { sessionId: 'session-a', type: 'issue-reconfirm-jump-to-bottom' },
            ],
        });

        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1700,
            distanceFromBottom: 180,
            isTrusted: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });

        host.clearNativeExplicitJumpConfirmation({ sessionId: 'session-a' });
        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1700,
            distanceFromBottom: 180,
            isTrusted: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [
                { sessionId: 'session-a', type: 'issue-entry-settle-reconfirm-pin' },
            ],
            explicitJumpEffects: [],
        });
    });

    it('resets native entry-settle confirmation through the lifecycle host', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        host.resetNativeEntrySettleConfirmation({
            sessionId: 'session-a',
            shouldArmConfirmation: true,
        });
        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1300,
            distanceFromBottom: 40,
            isTrusted: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1500,
            distanceFromBottom: 180,
            isTrusted: false,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [
                { sessionId: 'session-a', type: 'issue-entry-settle-reconfirm-pin' },
            ],
            explicitJumpEffects: [],
        });

        host.resetNativeEntrySettleConfirmation({
            sessionId: 'session-a',
            shouldArmConfirmation: false,
        });
        expect(host.observeNativeScrollConfirmation({
            bottomFollowMode: 'following',
            contentHeight: 1700,
            distanceFromBottom: 180,
            isTrusted: false,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
    });

    it('plans standalone native user-scroll takeover effects through one host', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.planNativeUserScrollTakeover({
            sessionId: 'session-a',
            timestampMs: 2000,
        });

        expect(plan.nativeUserScrollTakeoverEffects.map((effect) => effect.type)).toEqual([
            'native-user-scroll-preempt-entry-restore',
            'native-user-scroll-cancel-native-mount-settle-bottom-pin',
            'native-user-scroll-suppress-native-mount-settle-auto-pin',
            'native-user-scroll-clear-native-initial-viewport-pending-observation',
            'native-user-scroll-record-intent-timestamp',
        ]);
    });

    it('plans standalone native touch intent effects through one host', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.planNativeTouchIntent({
            hasActiveNativeViewportRestore: false,
            sessionId: 'session-a',
            timestampMs: 2000,
        });

        expect(plan.nativeTouchIntentEffects.map((effect) => effect.type)).toEqual([
            'native-touch-record-intent-timestamp',
            'native-touch-suppress-native-mount-settle-auto-pin',
            'native-touch-cancel-native-mount-settle-bottom-pin',
            'native-touch-cancel-scheduled-pin',
        ]);
    });

    it('groups native gesture, touch intent, and touch release effects through one host', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const gesturePlan = host.planNativeGestureStart({
            hasActiveNativeViewportRestore: false,
            sessionId: 'session-a',
            timestampMs: 2000,
        });
        const releasePlan = host.planNativeTouchRelease({
            distanceFromLiveTailPx: 180,
            pinThresholdPx: 72,
            sessionId: 'session-a',
        });

        expect(gesturePlan.nativeMomentumActiveMirrorEffects).toEqual([{
            active: false,
            sessionId: 'session-a',
            type: 'native-momentum-active-mirror',
        }]);
        expect(gesturePlan.nativeDragActiveMirrorEffects).toEqual([{
            active: true,
            sessionId: 'session-a',
            type: 'native-drag-active-mirror',
        }]);
        expect(gesturePlan.nativeUserScrollTakeoverEffects.map((effect) => effect.type)).toEqual([
            'native-user-scroll-preempt-entry-restore',
            'native-user-scroll-cancel-native-mount-settle-bottom-pin',
            'native-user-scroll-suppress-native-mount-settle-auto-pin',
            'native-user-scroll-clear-native-initial-viewport-pending-observation',
            'native-user-scroll-record-intent-timestamp',
        ]);
        expect(gesturePlan.nativeTouchIntentEffects.map((effect) => effect.type)).toEqual([
            'native-touch-record-intent-timestamp',
            'native-touch-suppress-native-mount-settle-auto-pin',
            'native-touch-cancel-native-mount-settle-bottom-pin',
            'native-touch-cancel-scheduled-pin',
        ]);
        const takeoverPlan = host.planNativeGestureTakeover({
            sessionId: 'session-a',
            timestampMs: 2100,
        });
        expect(takeoverPlan.nativeUserScrollTakeoverEffects.map((effect) => effect.type)).toEqual([
            'native-user-scroll-preempt-entry-restore',
            'native-user-scroll-cancel-native-mount-settle-bottom-pin',
            'native-user-scroll-suppress-native-mount-settle-auto-pin',
            'native-user-scroll-clear-native-initial-viewport-pending-observation',
            'native-user-scroll-record-intent-timestamp',
        ]);
        expect(takeoverPlan.nativeMomentumActiveMirrorEffects).toEqual([{
            active: false,
            sessionId: 'session-a',
            type: 'native-momentum-active-mirror',
        }]);
        expect(takeoverPlan.nativeDragActiveMirrorEffects).toEqual([{
            active: true,
            sessionId: 'session-a',
            type: 'native-drag-active-mirror',
        }]);
        expect(releasePlan.nativeTouchReleaseStateEffects).toEqual([{
            sessionId: 'session-a',
            type: 'apply-native-touch-release-live-tail-state',
        }]);
        expect(releasePlan.nativeBottomFollowRearmResetEffects).toEqual([{
            sessionId: 'session-a',
            type: 'reset-native-bottom-follow-rearm',
        }]);
    });

    it('plans measured native live-tail pins with existing native policy decisions', () => {
        const host = createTranscriptLifecycleHost();

        expect(host.planMeasuredNativeLiveTailPin(measuredPinInput({
            isMountSettleActive: true,
            skipAutomaticNativeJsPin: false,
        }))).toEqual({
            effect: {
                reason: 'content-size-change',
                sessionId: 'session-a',
                type: 'set-pending-native-mount-settle-bottom-pin',
            },
            preflightDecision: { type: 'defer-for-mount-settle' },
            type: 'defer-for-mount-settle',
        });

        const readyPlan = host.planMeasuredNativeLiveTailPin(measuredPinInput({
            isExplicitNativeCommand: true,
            reason: 'jump-to-bottom',
        }));

        expect(readyPlan.type).toBe('issue-command');
        if (readyPlan.type !== 'issue-command') {
            throw new Error('expected measured native pin command plan');
        }
        expect(readyPlan.commandPlan.commandInput).toMatchObject({
            observedContentHeightPx: 2400,
            observedLayoutHeightPx: 800,
            reason: 'jump-to-bottom',
            sessionId: 'session-a',
            skipNativeJsPin: false,
            type: 'auto-follow',
        });

        const nativeMaintenancePlan = host.planMeasuredNativeLiveTailPin(measuredPinInput({
            deferInitialViewportAppliedUntilObserved: true,
            hasInitialViewportApplied: false,
            shouldMarkInitialViewportApplied: false,
        }));

        expect(nativeMaintenancePlan.type).toBe('issue-command');
        if (nativeMaintenancePlan.type !== 'issue-command') {
            throw new Error('expected native-maintenance measured native pin command plan');
        }
        expect(nativeMaintenancePlan.commandPlan.postSuccess.initialViewportEffects).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });
        expect(nativeMaintenancePlan.invertedFollowBottomDecision).toEqual({
            clearPendingMountSettleBottomPin: true,
            issuePinBottomCommand: true,
            markInitialViewportApplied: true,
            type: 'handled',
        });
        expect(nativeMaintenancePlan.preAutoFollowDecision).toEqual({
            shouldRetryUnobservedBottomPin: false,
            type: 'continue',
        });
        expect(nativeMaintenancePlan.sameOffsetDecision).toEqual({ type: 'allow-pin' });
        expect(nativeMaintenancePlan.streamAppendDecision).toEqual({ type: 'allow-pin' });

        const duplicateStreamPlan = host.planMeasuredNativeLiveTailPin(measuredPinInput({
            lastStreamAppendPin: { contentHeight: 2400, sessionId: 'session-a' },
            reason: 'stream-append',
        }));

        expect(duplicateStreamPlan.type).toBe('issue-command');
        if (duplicateStreamPlan.type !== 'issue-command') {
            throw new Error('expected duplicate stream-append measured native pin command plan');
        }
        expect(duplicateStreamPlan.streamAppendDecision).toEqual({
            clearPendingMountSettleBottomPin: false,
            markInitialViewportApplied: false,
            reason: 'duplicate-stream-append-owner',
            type: 'skip-pin',
        });
    });

    it('plans pending mount-settle flushes through clear, wait, noop, and issue branches', () => {
        const host = createTranscriptLifecycleHost();

        expect(host.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: false,
            isMountSettleActive: false,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: true,
            sessionId: 'session-a',
        })).toEqual({
            decision: { type: 'clear-pending' },
            effects: [{
                sessionId: 'session-a',
                type: 'clear-pending-native-mount-settle-bottom-pin',
            }],
            type: 'clear-pending',
        });

        expect(host.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: true,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: true,
            sessionId: 'session-a',
        })).toEqual({
            decision: { type: 'wait-for-mount-settle' },
            effects: [],
            type: 'wait-for-mount-settle',
        });

        expect(host.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: false,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: false,
            sessionId: 'session-a',
        })).toEqual({
            decision: { type: 'noop' },
            effects: [],
            type: 'noop',
        });

        expect(host.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: false,
            mountSettleDeadlineReached: true,
            pendingMountSettleBottomPin: true,
            sessionId: 'session-a',
        })).toEqual({
            decision: { type: 'issue-mount-settle-pin' },
            effects: [{
                reason: 'mount-settle',
                sessionId: 'session-a',
                type: 'request-measured-native-live-tail-pin',
            }],
            type: 'issue-mount-settle-pin',
        });
    });

    it('does not re-arm web bottom-follow from a self-write echo clamped to the live tail', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        // The app's own prepend-restore write got clamped by the browser to the
        // bottom (prepended rows not laid out yet), so its echo frame arrives with
        // distanceFromLiveTail 0, RN-web `isTrusted: true`, and an apparent
        // toward-live-tail delta vs the user's last upward offset — but the DOM
        // observation attests the frame did NOT move since the recorded landed
        // value (`webMovedSinceLastObservation: false`). It must not re-arm.
        const echoPlan = host.observeScroll({
            distanceFromLiveTailPx: 0,
            isTrusted: true,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nowMs: 1000,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 500,
            scrollOffsetPx: 4283,
            sessionId: 'session-a',
            wantsPinned: false,
            webMovedSinceLastObservation: false,
            webObservedUserScrollMovement: false,
        });
        expect(echoPlan.state.bottomFollowState.mode).not.toBe('following');

        // A genuinely-attested trusted return to the live tail still re-arms.
        const genuineReturnPlan = host.observeScroll({
            distanceFromLiveTailPx: 0,
            isTrusted: true,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nowMs: 2000,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 4000,
            scrollOffsetPx: 4283,
            sessionId: 'session-a',
            wantsPinned: false,
            webMovedSinceLastObservation: true,
            webObservedUserScrollMovement: false,
        });
        expect(genuineReturnPlan.state.bottomFollowState.mode).toBe('following');
    });

    it('groups session-entry lifecycle reset and viewport plans', () => {
        const host = createTranscriptLifecycleHost();

        const plan = host.enterSession({
            entryDistanceFromLiveTailPx: 96,
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        expect(plan.renderResetEffects.platform).toBe('native');
        if (plan.renderResetEffects.platform !== 'native') {
            throw new Error('expected native reset plan');
        }
        expect(plan.renderResetEffects.nativeSessionViewportReset.type)
            .toBe('session-entry-native-session-viewport-reset');
        expect(plan.renderResetEffects.commandControllerReset.openEntryTransaction).toBe(true);
        expect(plan.viewportEffects).toEqual([{
            distanceFromLiveTailPx: 96,
            isPinned: false,
            jumpButtonDistanceFromLiveTailPx: 96,
            sessionId: 'session-a',
            shouldEmitViewportChange: true,
            shouldRestoreViewport: true,
            shouldUseEntryAnchor: true,
            type: 'apply-session-entry-viewport',
        }]);
    });
});

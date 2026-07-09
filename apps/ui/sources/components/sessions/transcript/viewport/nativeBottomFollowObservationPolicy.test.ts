import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    nativeBottomFollowCanApplyCompletion,
    nativeBottomFollowCanCompletePendingPin,
    nativeBottomFollowPinTargetObserved,
    resolveNativeBottomFollowCompletionEffects,
    resolveNativeBottomFollowPreviousFollow,
    resolveNativeContentMaterializationAutoPin,
    resolveNativeContentMaterializationAutoPinPostSuccessDecision,
    resolveNativeInitialFollowBottomDecision,
    resolveNativeInvertedFollowBottomPinDecision,
    resolveNativeMeasuredBottomPinMetricsDecision,
    resolveNativeMeasuredBottomPinCommandResultPlan,
    resolveNativeMeasuredBottomPinPreflightDecision,
    resolveNativeMeasuredBottomPinPreAutoFollowDecision,
    resolveNativeMountSettleIntervalDecision,
    resolveNativeMountSettleBottomPinRetention,
    resolveNativeMountSettlePendingFlushTriggerDecision,
    resolveNativeMountSettlePassiveDriftRepinDistanceDecision,
    resolveNativeMountSettlePassiveDriftRepinEffects,
    resolveNativeMountSettlePassiveDriftRepinPreflightDecision,
    resolveNativePendingMountSettleBottomPinFlushDecision,
    resolveNativeAutomaticPinOwnership,
    resolveNativeAutomaticPinRetryGuards,
    resolveNativeAutomaticPinSameOffsetDecision,
    resolveNativeStreamAppendContentVersionDecision,
    resolveNativeStreamAppendContentVersionRecord,
    resolveNativeSuccessfulBottomPinRecords,
    resolveNativeSuccessfulBottomPinInitialViewportEffects,
    shouldSkipNativeDefaultMaterializationPin,
} from './nativeBottomFollowObservationPolicy';

const POLICY_SOURCE = readFileSync(new URL('./nativeBottomFollowObservationPolicy.ts', import.meta.url), 'utf8');
const AUTOMATIC_PIN_OWNERSHIP_SOURCE =
    POLICY_SOURCE.match(/export function resolveNativeAutomaticPinOwnership\(([\s\S]*?)\n\}/)?.[1] ?? '';

describe('native bottom-follow observation policy', () => {
    it('observes pending bottom-pin targets by threshold distance or clamped overshoot', () => {
        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: 990,
        })).toBe(true);

        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: 1300,
        })).toBe(false);

        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: null,
        })).toBe(false);
    });

    it('allows pending bottom-follow completion when settle is stable, deadline reached, no pin is pending, or the target was observed', () => {
        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinTargetObserved: false,
        })).toBe(false);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
            pendingBottomPin: true,
            pinTargetObserved: false,
        })).toBe(true);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: false,
            pinTargetObserved: false,
        })).toBe(true);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinTargetObserved: true,
        })).toBe(true);
    });

    it('applies native bottom-follow completion only when pinned, at bottom, and completion is allowed', () => {
        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 8,
            isNative: true,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(true);

        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 18,
            isNative: true,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(false);

        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 8,
            isNative: false,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(false);
    });

    it('returns no completion effect outside the native bottom-follow path', () => {
        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 1400,
            distanceFromBottom: 0,
            isNative: false,
            lastNativePinOffset: 0,
            mountSettleDeadlineReached: true,
            mountSettleStable: true,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: 0,
            wantsPinned: true,
        })).toEqual([]);

        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 1400,
            distanceFromBottom: 120,
            isNative: true,
            lastNativePinOffset: 0,
            mountSettleDeadlineReached: true,
            mountSettleStable: true,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: 0,
            wantsPinned: true,
        })).toEqual([]);

        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 1400,
            distanceFromBottom: 0,
            isNative: true,
            lastNativePinOffset: 0,
            mountSettleDeadlineReached: true,
            mountSettleStable: true,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: 0,
            wantsPinned: false,
        })).toEqual([]);
    });

    it('completes immediately at bottom when no native bottom pin is pending', () => {
        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 1800,
            distanceFromBottom: 0,
            isNative: true,
            lastNativePinOffset: null,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: null,
            wantsPinned: true,
        })).toEqual([{
            entrySettleBaselineContentHeight: 1800,
            sessionId: 'session-a',
            type: 'complete-native-bottom-follow',
        }]);
    });

    it('completes a pending native bottom pin once settle is stable, deadline is reached, or the pin target is observed', () => {
        const base = {
            contentHeight: 2200,
            distanceFromBottom: 6,
            isNative: true,
            lastNativePinOffset: 1000,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: 1000,
            wantsPinned: true,
        } as const;

        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
        })).toEqual([{
            entrySettleBaselineContentHeight: 2200,
            sessionId: 'session-a',
            type: 'complete-native-bottom-follow',
        }]);

        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
        })).toEqual([{
            entrySettleBaselineContentHeight: 2200,
            sessionId: 'session-a',
            type: 'complete-native-bottom-follow',
        }]);

        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
        })).toEqual([{
            entrySettleBaselineContentHeight: 2200,
            sessionId: 'session-a',
            type: 'complete-native-bottom-follow',
        }]);
    });

    it('keeps pending native bottom pins open until a stable/deadline/target observation can complete them', () => {
        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 2200,
            distanceFromBottom: 6,
            isNative: true,
            lastNativePinOffset: 1000,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: 1200,
            wantsPinned: true,
        })).toEqual([]);

        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 2200,
            distanceFromBottom: 6,
            isNative: true,
            lastNativePinOffset: 1000,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            usesNativeFlashListBottomMaintenance: false,
            visualBottomScrollOffset: 1000,
            wantsPinned: true,
        })).toEqual([]);
    });

    it('captures previous native bottom-follow only for active native hot-tail following without recent user intent', () => {
        expect(resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isNative: true,
            lastUserScrollIntentAtMs: 0,
            nativeHotTailHeightPx: 80,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBe(true);

        expect(resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isNative: false,
            lastUserScrollIntentAtMs: 0,
            nativeHotTailHeightPx: 80,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBe(false);

        expect(resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isNative: true,
            lastUserScrollIntentAtMs: 0,
            nativeHotTailHeightPx: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBe(false);

        expect(resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'released',
            isNative: true,
            lastUserScrollIntentAtMs: 0,
            nativeHotTailHeightPx: 80,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBe(false);

        expect(resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isNative: true,
            lastUserScrollIntentAtMs: 1500,
            nativeHotTailHeightPx: 80,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBe(false);
    });

    it('retains native mount-settle bottom pins only while native maintenance and mount-settle auto-follow are allowed', () => {
        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: true,
            hasRearmedNativeBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
        })).toBe(true);

        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: true,
            hasRearmedNativeBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: false,
        })).toBe(false);

        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: true,
            hasRearmedNativeBottomFollow: false,
            isJumpToSeqActive: true,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
        })).toBe(false);

        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: false,
            hasRearmedNativeBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
        })).toBe(false);
    });

    it('retains native mount-settle bottom pins during a recent user-intent window only after bottom-follow was rearmed', () => {
        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: true,
            hasRearmedNativeBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 1500,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
        })).toBe(false);

        expect(resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: 1000,
            canAutoFollowMountSettle: true,
            hasRearmedNativeBottomFollow: true,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 1500,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
        })).toBe(true);
    });

    it('allows mount-settle passive-drift repin preflight when the active native follow-bottom path is eligible', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isMountSettleActive: true,
            isNative: true,
            isTrusted: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toEqual({ type: 'check-current-distance' });
    });

    it('blocks mount-settle passive-drift repin preflight for web or trusted observations', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isMountSettleActive: true,
            isNative: false,
            isTrusted: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toEqual({
            reason: 'not-native',
            type: 'ignore',
        });

        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following',
            isMountSettleActive: true,
            isNative: true,
            isTrusted: true,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toEqual({
            reason: 'trusted-observation',
            type: 'ignore',
        });
    });

    it('blocks mount-settle passive-drift repin preflight when correction is not eligible', () => {
        const eligible = {
            autoPinDelayMs: 1000,
            bottomFollowMode: 'following' as const,
            isMountSettleActive: true,
            isNative: true,
            isTrusted: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        };

        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            ...eligible,
            usesNativeFlashListBottomMaintenance: false,
        })).toEqual({
            reason: 'native-maintenance-disabled',
            type: 'ignore',
        });
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            ...eligible,
            wantsPinned: false,
        })).toEqual({
            reason: 'not-wants-live-tail',
            type: 'ignore',
        });
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            ...eligible,
            bottomFollowMode: 'released',
        })).toEqual({
            reason: 'not-following',
            type: 'ignore',
        });
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            ...eligible,
            isMountSettleActive: false,
        })).toEqual({
            reason: 'mount-settle-inactive',
            type: 'ignore',
        });
        expect(resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            ...eligible,
            lastUserScrollIntentAtMs: 1500,
        })).toEqual({
            reason: 'recent-user-intent',
            type: 'ignore',
        });
    });

    it('skips mount-settle passive-drift repin when the current distance is not measurable', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx: null,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'unmeasured-distance',
            type: 'skip',
        });
    });

    it('skips mount-settle passive-drift repin at or within the live-tail threshold', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx: 72,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'within-live-tail-threshold',
            type: 'skip',
        });
        expect(resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx: 24,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'within-live-tail-threshold',
            type: 'skip',
        });
    });

    it('requests mount-settle passive-drift repin only beyond the live-tail threshold', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx: 73,
            pinThresholdPx: 72,
        })).toEqual({ type: 'request-repin' });
    });

    it('returns no mount-settle passive-drift repin effects for skipped distance decisions', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinEffects({
            decision: { reason: 'unmeasured-distance', type: 'skip' },
            sessionId: 'session-a',
        })).toEqual([]);
        expect(resolveNativeMountSettlePassiveDriftRepinEffects({
            decision: { reason: 'within-live-tail-threshold', type: 'skip' },
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('packages mount-settle passive-drift repin requests as session-scoped measured native automatic live-tail pin effects', () => {
        expect(resolveNativeMountSettlePassiveDriftRepinEffects({
            decision: { type: 'request-repin' },
            sessionId: 'session-a',
        })).toEqual([{
            reason: 'layout-change',
            sessionId: 'session-a',
            type: 'request-measured-native-automatic-live-tail-pin',
        }]);
    });

    it('no-ops pending mount-settle bottom-pin flushes when no pin is pending and no deadline fired', () => {
        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: false,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: false,
        })).toEqual({ type: 'noop' });
    });

    it('clears pending mount-settle bottom pins when retention is disallowed', () => {
        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: false,
            isMountSettleActive: false,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'clear-pending' });

        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: false,
            isMountSettleActive: false,
            mountSettleDeadlineReached: true,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'clear-pending' });
    });

    it('waits for active mount-settle before flushing unless the deadline has fired', () => {
        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: true,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'wait-for-mount-settle' });

        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: true,
            mountSettleDeadlineReached: true,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'issue-mount-settle-pin' });
    });

    it('issues pending mount-settle bottom pins when inactive or deadline-triggered', () => {
        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: false,
            mountSettleDeadlineReached: false,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'issue-mount-settle-pin' });

        expect(resolveNativePendingMountSettleBottomPinFlushDecision({
            canRetainPendingMountSettleBottomPin: true,
            isMountSettleActive: false,
            mountSettleDeadlineReached: true,
            pendingMountSettleBottomPin: false,
        })).toEqual({ type: 'issue-mount-settle-pin' });
    });

    it('flushes pending mount-settle pins when mount settle becomes stable', () => {
        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: true,
            hasInitialViewportApplied: true,
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
        })).toEqual({ type: 'flush-pending' });
    });

    it('no-ops mount-settle pending flush triggers before stable or deadline states', () => {
        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
        })).toEqual({ type: 'noop' });
    });

    it('no-ops deadline-triggered mount-settle flushes when auto-pin is suppressed or already applied', () => {
        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: true,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
        })).toEqual({ type: 'noop' });

        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: true,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
        })).toEqual({ type: 'noop' });
    });

    it('requests a pending mount-settle flush when the deadline fires before initial viewport application', () => {
        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: true,
            mountSettleStable: false,
        })).toEqual({ type: 'request-pending-flush' });
    });

    it('lets stable mount-settle state win over deadline facts', () => {
        expect(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: true,
            mountSettleStable: true,
        })).toEqual({ type: 'flush-pending' });
    });

    it('resolves native mount-settle interval samples as stable when settle is stable', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: true,
            deadlineMs: 1000,
            nowMs: 1500,
            stableSettle: true,
        })).toEqual({ type: 'stable' });
    });

    it('continues native mount-settle interval sampling before the deadline when settle is not stable', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: false,
            deadlineMs: 1000,
            nowMs: 999,
            stableSettle: false,
        })).toEqual({ type: 'continue' });
    });

    it('resolves native mount-settle interval samples as deadline at the deadline boundary', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: false,
            deadlineMs: 1000,
            nowMs: 1000,
            stableSettle: false,
        })).toEqual({
            requestPendingFlush: true,
            type: 'deadline',
        });
    });

    it('does not request a pending flush at the interval deadline when auto-pin is suppressed', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: true,
            deadlineMs: 1000,
            nowMs: 1200,
            stableSettle: false,
        })).toEqual({
            requestPendingFlush: false,
            type: 'deadline',
        });
    });

    it('requests a pending flush at the interval deadline when auto-pin is allowed', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: false,
            deadlineMs: 1000,
            nowMs: 1200,
            stableSettle: false,
        })).toEqual({
            requestPendingFlush: true,
            type: 'deadline',
        });
    });

    it('lets stable interval samples win over deadline and suppression facts', () => {
        expect(resolveNativeMountSettleIntervalDecision({
            autoPinSuppressed: true,
            deadlineMs: 1000,
            nowMs: 1200,
            stableSettle: true,
        })).toEqual({ type: 'stable' });
    });

    it('blocks native measured bottom pins when native maintenance is disabled', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: false,
        })).toEqual({ type: 'blocked' });
    });

    it('blocks non-jump native measured bottom pins during jump-to-seq but lets jump-to-seq through', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: true,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: true,
            isJumpToSeqActive: true,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'jump-to-seq',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });
    });

    it('blocks native measured bottom pins when auto-follow is not allowed', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: false,
            forceMountSettle: false,
            hasRearmedBottomFollow: true,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'blocked' });
    });

    it('blocks recent non-explicit user intent unless native bottom-follow was rearmed', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 1500,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: true,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 1500,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });
    });

    it('lets explicit native measured bottom pins bypass the recent user-intent delay', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: true,
            isJumpToSeqActive: false,
            isMountSettleActive: false,
            lastUserScrollIntentAtMs: 1500,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'jump-to-bottom',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });
    });

    it('defers JS-owned automatic native measured bottom pins during active mount settle before the deadline', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: true,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'defer-for-mount-settle' });
    });

    it('continues mount-settle preflight after deadline, forced retries, explicit commands, or native-owned automatic pins', () => {
        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: true,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: true,
            nowMs: 2000,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });

        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: true,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: true,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'mount-settle',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });

        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: true,
            isJumpToSeqActive: false,
            isMountSettleActive: true,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'jump-to-bottom',
            skipAutomaticNativeJsPin: false,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });

        expect(resolveNativeMeasuredBottomPinPreflightDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            forceMountSettle: false,
            hasRearmedBottomFollow: false,
            isExplicitNativeCommand: false,
            isJumpToSeqActive: false,
            isMountSettleActive: true,
            lastUserScrollIntentAtMs: 0,
            mountSettleDeadlineReached: false,
            nowMs: 2000,
            reason: 'stream-append',
            skipAutomaticNativeJsPin: true,
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({ type: 'continue' });
    });

    it('blocks measured bottom-pin metrics when current-session content measurement is missing', () => {
        expect(resolveNativeMeasuredBottomPinMetricsDecision({
            contentHeight: 1200,
            hasContentMeasurement: false,
            layoutHeight: 800,
        })).toEqual({
            reason: 'missing-content-measurement',
            type: 'not-ready',
        });
    });

    it('blocks measured bottom-pin metrics for non-finite or non-positive layout heights', () => {
        for (const layoutHeight of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
            expect(resolveNativeMeasuredBottomPinMetricsDecision({
                contentHeight: 1200,
                hasContentMeasurement: true,
                layoutHeight,
            })).toEqual({
                reason: 'invalid-layout-height',
                type: 'not-ready',
            });
        }
    });

    it('blocks measured bottom-pin metrics for non-finite or non-positive content heights', () => {
        for (const contentHeight of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
            expect(resolveNativeMeasuredBottomPinMetricsDecision({
                contentHeight,
                hasContentMeasurement: true,
                layoutHeight: 800,
            })).toEqual({
                reason: 'invalid-content-height',
                type: 'not-ready',
            });
        }
    });

    it('keeps measured bottom-pin metrics ready when content is shorter than the viewport', () => {
        expect(resolveNativeMeasuredBottomPinMetricsDecision({
            contentHeight: 600,
            hasContentMeasurement: true,
            layoutHeight: 800,
        })).toEqual({
            bottomOffsetPx: 0,
            contentHeight: 600,
            layoutHeight: 800,
            type: 'ready',
        });
    });

    it('preserves fractional measured metrics and truncates only the derived bottom offset', () => {
        expect(resolveNativeMeasuredBottomPinMetricsDecision({
            contentHeight: 1234.9,
            hasContentMeasurement: true,
            layoutHeight: 800.2,
        })).toEqual({
            bottomOffsetPx: 434,
            contentHeight: 1234.9,
            layoutHeight: 800.2,
            type: 'ready',
        });
    });

    it('continues inverted follow-bottom pin handling when inverted bottom establishment is inactive', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 120,
            forceFollowPin: true,
            hasInitialViewportApplied: false,
            invertedFirstPaintEstablishesBottom: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ type: 'continue' });
    });

    it('continues inverted follow-bottom pin handling when the user does not want bottom follow', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 120,
            forceFollowPin: true,
            hasInitialViewportApplied: false,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: false,
        })).toEqual({ type: 'continue' });
    });

    it('continues inverted follow-bottom pin handling when bottom-follow mode is not following', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'released',
            distanceFromBottom: 120,
            forceFollowPin: true,
            hasInitialViewportApplied: false,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ type: 'continue' });
    });

    it('marks initial viewport applied and clears pending mount-settle when inverted following is first handled', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 12,
            forceFollowPin: false,
            hasInitialViewportApplied: false,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: true,
            issuePinBottomCommand: false,
            markInitialViewportApplied: true,
            type: 'handled',
        });
    });

    it('handles inverted following without issuing a command when already within threshold', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 12,
            forceFollowPin: false,
            hasInitialViewportApplied: true,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            issuePinBottomCommand: false,
            markInitialViewportApplied: false,
            type: 'handled',
        });
    });

    it('handles inverted following without issuing a command when distance is unavailable and force is false', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: null,
            forceFollowPin: false,
            hasInitialViewportApplied: true,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            issuePinBottomCommand: false,
            markInitialViewportApplied: false,
            type: 'handled',
        });
    });

    it('issues an inverted follow-bottom command when distance exceeds the threshold', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 120,
            forceFollowPin: false,
            hasInitialViewportApplied: true,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            issuePinBottomCommand: true,
            markInitialViewportApplied: false,
            type: 'handled',
        });
    });

    it('issues an inverted follow-bottom command when forced even if distance is unavailable or within threshold', () => {
        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: null,
            forceFollowPin: true,
            hasInitialViewportApplied: true,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            issuePinBottomCommand: true,
            markInitialViewportApplied: false,
            type: 'handled',
        });

        expect(resolveNativeInvertedFollowBottomPinDecision({
            bottomFollowMode: 'following',
            distanceFromBottom: 12,
            forceFollowPin: true,
            hasInitialViewportApplied: true,
            invertedFirstPaintEstablishesBottom: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            issuePinBottomCommand: true,
            markInitialViewportApplied: false,
            type: 'handled',
        });
    });

    it('allows native content materialization auto-pin for eligible content-size growth after initial viewport application', () => {
        expect(resolveNativeContentMaterializationAutoPin({
            contentHeight: 2400,
            hasInitialViewportApplied: true,
            isNative: true,
            lastBottomFollowPinCommandSessionId: null,
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 1200,
            reason: 'content-size-change',
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toEqual({
            contentHeight: 2400,
            sessionId: 'session-1',
        });
    });

    it('allows native content materialization auto-pin before initial viewport application after a same-session bottom-follow pin command', () => {
        expect(resolveNativeContentMaterializationAutoPin({
            contentHeight: 2200,
            hasInitialViewportApplied: false,
            isNative: true,
            lastBottomFollowPinCommandSessionId: 'session-1',
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 1200,
            reason: 'content-size-change',
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toEqual({
            contentHeight: 2200,
            sessionId: 'session-1',
        });
    });

    it('blocks native content materialization auto-pin outside native bottom-maintenance content-size changes', () => {
        const base = {
            contentHeight: 2400,
            hasInitialViewportApplied: true,
            isNative: true,
            lastBottomFollowPinCommandSessionId: null,
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 1200,
            reason: 'content-size-change' as const,
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        };

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            isNative: false,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            usesNativeFlashListBottomMaintenance: false,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            reason: 'stream-append',
        })).toBeNull();
    });

    it('blocks native content materialization auto-pin when follow intent or session ownership is missing', () => {
        const base = {
            contentHeight: 2400,
            hasInitialViewportApplied: false,
            isNative: true,
            lastBottomFollowPinCommandSessionId: 'other-session',
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 1200,
            reason: 'content-size-change' as const,
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        };

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            wantsPinned: false,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin(base)).toBeNull();
    });

    it('blocks native content materialization auto-pin for invalid or insufficient measurements', () => {
        const base = {
            contentHeight: 2400,
            hasInitialViewportApplied: true,
            isNative: true,
            lastBottomFollowPinCommandSessionId: null,
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 1200,
            reason: 'content-size-change' as const,
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        };

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            previousContentHeight: 0,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            previousContentHeight: Number.NaN,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            layoutHeight: 0,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            layoutHeight: Number.POSITIVE_INFINITY,
        })).toBeNull();

        expect(resolveNativeContentMaterializationAutoPin({
            ...base,
            contentHeight: 1800,
        })).toBeNull();
    });

    it('blocks native content materialization auto-pin when the previous target offset was too far from bottom', () => {
        expect(resolveNativeContentMaterializationAutoPin({
            contentHeight: 4000,
            hasInitialViewportApplied: true,
            isNative: true,
            lastBottomFollowPinCommandSessionId: null,
            layoutHeight: 800,
            pinThresholdPx: 72,
            previousContentHeight: 2200,
            reason: 'content-size-change',
            sessionId: 'session-1',
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toBeNull();
    });

    it('skips automatic default native materialization pins for initial-open and layout-change when native JS pinning is active', () => {
        const base = {
            contentHeight: 1200,
            isExplicitNativeCommand: false,
            materializationAutoPin: null,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            reason: 'initial-open',
        })).toBe(true);

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            reason: 'layout-change',
        })).toBe(true);
    });

    it('skips automatic content-size-change materialization pins without a matching one-shot permission', () => {
        const base = {
            contentHeight: 2400,
            isExplicitNativeCommand: false,
            reason: 'content-size-change' as const,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            materializationAutoPin: null,
        })).toBe(true);

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            materializationAutoPin: {
                contentHeight: 2400,
                sessionId: 'other-session',
            },
        })).toBe(true);

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            materializationAutoPin: {
                contentHeight: 2000,
                sessionId: 'session-1',
            },
        })).toBe(true);
    });

    it('allows automatic content-size-change materialization pins with a matching one-shot permission', () => {
        expect(shouldSkipNativeDefaultMaterializationPin({
            contentHeight: 2400,
            isExplicitNativeCommand: false,
            materializationAutoPin: {
                contentHeight: 2400,
                sessionId: 'session-1',
            },
            reason: 'content-size-change',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toBe(false);
    });

    it('allows native default materialization pins when native JS pinning is already skipped, the command is explicit, or the reason is unrelated', () => {
        const base = {
            contentHeight: 2400,
            isExplicitNativeCommand: false,
            materializationAutoPin: null,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            reason: 'content-size-change',
            skipAutomaticNativeJsPin: true,
        })).toBe(false);

        expect(shouldSkipNativeDefaultMaterializationPin({
            ...base,
            isExplicitNativeCommand: true,
            reason: 'initial-open',
        })).toBe(false);

        for (const reason of ['stream-append', 'mount-settle', 'jump-to-bottom', 'jump-to-seq'] as const) {
            expect(shouldSkipNativeDefaultMaterializationPin({
                ...base,
                reason,
            })).toBe(false);
        }
    });

    it('clears native content-materialization auto-pin permission after successful content-size changes', () => {
        expect(resolveNativeContentMaterializationAutoPinPostSuccessDecision({
            reason: 'content-size-change',
        })).toEqual({ clearMaterializationAutoPin: true });
    });

    it('keeps native content-materialization auto-pin permission for non-content-size success reasons', () => {
        for (const reason of [
            'stream-append',
            'mount-settle',
            'layout-change',
            'initial-open',
            'jump-to-bottom',
            'jump-to-seq',
        ] as const) {
            expect(resolveNativeContentMaterializationAutoPinPostSuccessDecision({
                reason,
            })).toEqual({ clearMaterializationAutoPin: false });
        }
    });

    it('keeps native automatic pin ownership orientation-free after native inversion became canonical', () => {
        expect(AUTOMATIC_PIN_OWNERSHIP_SOURCE).not.toContain('listOrientation');

        expect(resolveNativeAutomaticPinOwnership({
            isExplicitNativeCommand: false,
            reason: 'stream-append',
        })).toEqual({
            invertedFirstPaintEstablishesBottom: true,
            skipJsPin: true,
        });
    });

    it('keeps explicit native commands JS-owned', () => {
        expect(resolveNativeAutomaticPinOwnership({
            isExplicitNativeCommand: true,
            reason: 'jump-to-bottom',
        })).toEqual({
            invertedFirstPaintEstablishesBottom: false,
            skipJsPin: false,
        });

        expect(resolveNativeAutomaticPinOwnership({
            isExplicitNativeCommand: true,
            reason: 'jump-to-seq',
        })).toEqual({
            invertedFirstPaintEstablishesBottom: false,
            skipJsPin: false,
        });
    });

    it('keeps stream-append automatic ownership native-maintenance-owned with first-paint bottom establishment', () => {
        expect(resolveNativeAutomaticPinOwnership({
            isExplicitNativeCommand: false,
            reason: 'stream-append',
        })).toEqual({
            invertedFirstPaintEstablishesBottom: true,
            skipJsPin: true,
        });
    });

    it('keeps every automatic reason native-maintenance-owned with first-paint bottom establishment', () => {
        for (const reason of [
            'initial-open',
            'layout-change',
            'content-size-change',
            'mount-settle',
            'entry-restore',
            'prepend-restore',
            'passive-drift',
        ] as const) {
            expect(resolveNativeAutomaticPinOwnership({
                isExplicitNativeCommand: false,
                reason,
            })).toEqual({
                invertedFirstPaintEstablishesBottom: true,
                skipJsPin: true,
            });
        }
    });

    it('retries unobserved native bottom pins only after positive-offset pending pins settle before initial viewport application', () => {
        const base = {
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: true,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'layout-change' as const,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeAutomaticPinRetryGuards(base).shouldRetryUnobservedBottomPin).toBe(true);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            offset: 0,
        }).shouldRetryUnobservedBottomPin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            pendingMountSettleBottomPin: false,
        }).shouldRetryUnobservedBottomPin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            hasInitialViewportApplied: true,
        }).shouldRetryUnobservedBottomPin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            nativeMountSettleStable: false,
        }).shouldRetryUnobservedBottomPin).toBe(false);
    });

    it('skips unstable automatic JS-owned initial-open retries while waiting for bottom observation', () => {
        const base = {
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'initial-open' as const,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeAutomaticPinRetryGuards(base).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(true);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            isExplicitNativeCommand: true,
        }).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            skipAutomaticNativeJsPin: true,
        }).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            reason: 'layout-change',
        }).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            offset: 0,
        }).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            pendingMountSettleBottomPin: false,
        }).shouldSkipUnstableAutomaticRetryUntilObserved).toBe(false);
    });

    it('skips late automatic initial-open after a same-session automatic bottom-pin command', () => {
        const base = {
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            nativeAutomaticBottomPinCommandSessionId: 'session-1',
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open' as const,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeAutomaticPinRetryGuards(base).shouldSkipLateInitialOpenAfterAutomaticNativePin).toBe(true);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            nativeAutomaticBottomPinCommandSessionId: 'other-session',
        }).shouldSkipLateInitialOpenAfterAutomaticNativePin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            isExplicitNativeCommand: true,
        }).shouldSkipLateInitialOpenAfterAutomaticNativePin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            skipAutomaticNativeJsPin: true,
        }).shouldSkipLateInitialOpenAfterAutomaticNativePin).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            reason: 'layout-change',
        }).shouldSkipLateInitialOpenAfterAutomaticNativePin).toBe(false);
    });

    it('skips duplicate automatic retries for matching offsets and pending initial-open observations', () => {
        const base = {
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: 160,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'layout-change' as const,
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeAutomaticPinRetryGuards(base).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(true);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            offset: 200,
            reason: 'initial-open',
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(true);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            forceMountSettle: true,
            reason: 'mount-settle',
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            offset: 0,
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            pendingMountSettleBottomPin: false,
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            lastNativePinOffset: null,
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            isExplicitNativeCommand: true,
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
        expect(resolveNativeAutomaticPinRetryGuards({
            ...base,
            skipAutomaticNativeJsPin: true,
        }).shouldSkipDuplicateAutomaticRetryUntilObserved).toBe(false);
    });

    it('skips pre-auto-follow pins for default initial-open materialization and keeps pending before initial viewport application', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
        });
    });

    it('skips pre-auto-follow pins for default layout materialization without keeping pending after initial viewport application', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: true,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'layout-change',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
        });
    });

    it('skips pre-auto-follow content-size materialization without a matching one-shot permission', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 2400,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: {
                contentHeight: 2000,
                sessionId: 'session-1',
            },
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'content-size-change',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
        });
    });

    it('skips pre-auto-follow pins while an unstable automatic retry is waiting for observation', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'initial-open',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
        });
    });

    it('skips pre-auto-follow pins for late automatic initial-open after a same-session automatic command', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: 'session-1',
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
        });
    });

    it('skips pre-auto-follow duplicate automatic retries while pending observation exists', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: 160,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'layout-change',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
        });
    });

    it('continues pre-auto-follow pins when no skip reason applies', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: true,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: false,
            offset: 0,
            pendingMountSettleBottomPin: false,
            reason: 'mount-settle',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            shouldRetryUnobservedBottomPin: false,
            type: 'continue',
        });
    });

    it('continues pre-auto-follow pins with the unobserved pending-pin retry fact when no skip reason applies', () => {
        expect(resolveNativeMeasuredBottomPinPreAutoFollowDecision({
            contentHeight: 1200,
            forceMountSettle: false,
            hasInitialViewportApplied: false,
            isExplicitNativeCommand: false,
            lastNativePinOffset: null,
            materializationAutoPin: null,
            nativeAutomaticBottomPinCommandSessionId: null,
            nativeMountSettleStable: true,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'mount-settle',
            sessionId: 'session-1',
            skipAutomaticNativeJsPin: true,
        })).toEqual({
            shouldRetryUnobservedBottomPin: true,
            type: 'continue',
        });
    });

    it('skips non-forced same-offset native bottom pins when no unobserved retry is required', () => {
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            deferInitialViewportAppliedUntilObserved: false,
            force: false,
            hasInitialViewportApplied: false,
            lastNativePinOffset: 160,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'layout-change',
            shouldRetryUnobservedBottomPin: false,
        })).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: false,
        });
    });

    it('keeps pending mount-settle bottom pin on deferred positive-offset same-offset skips', () => {
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            deferInitialViewportAppliedUntilObserved: true,
            force: false,
            hasInitialViewportApplied: false,
            lastNativePinOffset: 160,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'layout-change',
            shouldRetryUnobservedBottomPin: false,
        })).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: true,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: false,
        });
    });

    it('allows non-forced same-offset pins when the target differs, is missing, is forced, or an unobserved retry is required', () => {
        const base = {
            deferInitialViewportAppliedUntilObserved: false,
            force: false,
            hasInitialViewportApplied: false,
            lastNativePinOffset: 160,
            offset: 160,
            pendingMountSettleBottomPin: false,
            reason: 'layout-change' as const,
            shouldRetryUnobservedBottomPin: false,
        };

        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            offset: 200,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            lastNativePinOffset: null,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            force: true,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            shouldRetryUnobservedBottomPin: true,
        })).toEqual({ type: 'allow-pin' });
    });

    it('skips forced mount-settle same-offset pins only while a pending unapplied mount-settle pin exists', () => {
        const base = {
            deferInitialViewportAppliedUntilObserved: true,
            force: true,
            hasInitialViewportApplied: false,
            lastNativePinOffset: 160,
            offset: 160,
            pendingMountSettleBottomPin: true,
            reason: 'mount-settle' as const,
            shouldRetryUnobservedBottomPin: false,
        };

        expect(resolveNativeAutomaticPinSameOffsetDecision(base)).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: true,
        });

        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            reason: 'layout-change',
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            pendingMountSettleBottomPin: false,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            hasInitialViewportApplied: true,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            offset: 200,
        })).toEqual({ type: 'allow-pin' });
    });

    it('does not refresh pending observation for forced mount-settle same-offset skips without deferred positive offset', () => {
        const base = {
            deferInitialViewportAppliedUntilObserved: true,
            force: true,
            hasInitialViewportApplied: false,
            lastNativePinOffset: 0,
            offset: 0,
            pendingMountSettleBottomPin: true,
            reason: 'mount-settle' as const,
            shouldRetryUnobservedBottomPin: false,
        };

        expect(resolveNativeAutomaticPinSameOffsetDecision(base)).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: false,
        });

        expect(resolveNativeAutomaticPinSameOffsetDecision({
            ...base,
            deferInitialViewportAppliedUntilObserved: false,
        })).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: false,
        });
    });

    it('allows native stream-append content-version pins when no matching prior stream owner exists', () => {
        const base = {
            contentHeight: 1200,
            isExplicitNativeCommand: false,
            lastStreamAppendPin: null,
            reason: 'stream-append' as const,
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: true,
        };

        expect(resolveNativeStreamAppendContentVersionDecision(base)).toEqual({ type: 'allow-pin' });
        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            lastStreamAppendPin: { contentHeight: 1200, sessionId: 'other' },
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            lastStreamAppendPin: { contentHeight: 1300, sessionId: 's1' },
        })).toEqual({ type: 'allow-pin' });
    });

    it('skips duplicate native-maintenance-owned stream-append content versions', () => {
        expect(resolveNativeStreamAppendContentVersionDecision({
            contentHeight: 1200,
            isExplicitNativeCommand: false,
            lastStreamAppendPin: { contentHeight: 1200, sessionId: 's1' },
            reason: 'stream-append',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: true,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            markInitialViewportApplied: false,
            reason: 'duplicate-stream-append-owner',
            type: 'skip-pin',
        });
    });

    it('skips non-explicit mount-settle pins already owned by the stream-append content version', () => {
        const base = {
            contentHeight: 1200,
            isExplicitNativeCommand: false,
            lastStreamAppendPin: { contentHeight: 1200, sessionId: 's1' },
            reason: 'mount-settle' as const,
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeStreamAppendContentVersionDecision(base)).toEqual({
            clearPendingMountSettleBottomPin: true,
            markInitialViewportApplied: true,
            reason: 'mount-settle-owned-by-stream-append',
            type: 'skip-pin',
        });
        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            shouldMarkInitialViewportApplied: false,
        })).toEqual({
            clearPendingMountSettleBottomPin: false,
            markInitialViewportApplied: false,
            reason: 'mount-settle-owned-by-stream-append',
            type: 'skip-pin',
        });
    });

    it('allows explicit and non-mount-settle JS-owned pins even with a matching stream content version', () => {
        const base = {
            contentHeight: 1200,
            isExplicitNativeCommand: false,
            lastStreamAppendPin: { contentHeight: 1200, sessionId: 's1' },
            reason: 'mount-settle' as const,
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
        };

        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            isExplicitNativeCommand: true,
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            reason: 'content-size-change',
        })).toEqual({ type: 'allow-pin' });
        expect(resolveNativeStreamAppendContentVersionDecision({
            ...base,
            reason: 'layout-change',
        })).toEqual({ type: 'allow-pin' });
    });

    it('records successful native-maintenance-owned stream-append content versions', () => {
        expect(resolveNativeStreamAppendContentVersionRecord({
            contentHeight: 1200,
            reason: 'stream-append',
            sessionId: 's1',
            skipAutomaticNativeJsPin: true,
        })).toEqual({
            contentHeight: 1200,
            sessionId: 's1',
        });
    });

    it('does not record JS-owned stream-append or non-stream native-maintenance-owned content versions', () => {
        expect(resolveNativeStreamAppendContentVersionRecord({
            contentHeight: 1200,
            reason: 'stream-append',
            sessionId: 's1',
            skipAutomaticNativeJsPin: false,
        })).toBeNull();

        for (const reason of ['initial-open', 'layout-change', 'content-size-change', 'mount-settle'] as const) {
            expect(resolveNativeStreamAppendContentVersionRecord({
                contentHeight: 1200,
                reason,
                sessionId: 's1',
                skipAutomaticNativeJsPin: true,
            })).toBeNull();
        }
    });

    it('records all successful JS-owned automatic native bottom-pin bookkeeping facts', () => {
        expect(resolveNativeSuccessfulBottomPinRecords({
            isExplicitNativeCommand: false,
            offset: 320,
            sessionId: 's1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            automaticBottomPinCommandSessionId: 's1',
            bottomFollowPinCommand: {
                offsetY: 320,
                sessionId: 's1',
            },
            lastNativePinOffset: 320,
        });
    });

    it('records only the successful offset for explicit JS-owned native bottom pins', () => {
        expect(resolveNativeSuccessfulBottomPinRecords({
            isExplicitNativeCommand: true,
            offset: 320,
            sessionId: 's1',
            skipAutomaticNativeJsPin: false,
        })).toEqual({
            automaticBottomPinCommandSessionId: null,
            bottomFollowPinCommand: null,
            lastNativePinOffset: 320,
        });
    });

    it('records no JS-owned bottom-pin facts for native-maintenance-owned pins', () => {
        expect(resolveNativeSuccessfulBottomPinRecords({
            isExplicitNativeCommand: false,
            offset: 320,
            sessionId: 's1',
            skipAutomaticNativeJsPin: true,
        })).toEqual({
            automaticBottomPinCommandSessionId: null,
            bottomFollowPinCommand: null,
            lastNativePinOffset: null,
        });
    });

    it('marks native initial viewport applied immediately for non-deferred successful bottom pins', () => {
        expect(resolveNativeSuccessfulBottomPinInitialViewportEffects({
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            offset: 320,
            shouldMarkInitialViewportApplied: true,
        })).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });
    });

    it('marks native initial viewport applied for deferred zero-offset or inverted first-paint bottom establishment', () => {
        const base = {
            deferInitialViewportAppliedUntilObserved: true,
            invertedFirstPaintEstablishesBottom: false,
            offset: 0,
            shouldMarkInitialViewportApplied: false,
        };

        expect(resolveNativeSuccessfulBottomPinInitialViewportEffects(base)).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });
        expect(resolveNativeSuccessfulBottomPinInitialViewportEffects({
            ...base,
            invertedFirstPaintEstablishesBottom: true,
            offset: 320,
        })).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });
    });

    it('keeps native initial viewport pending for deferred positive-offset non-inverted successful bottom pins', () => {
        expect(resolveNativeSuccessfulBottomPinInitialViewportEffects({
            deferInitialViewportAppliedUntilObserved: true,
            invertedFirstPaintEstablishesBottom: false,
            offset: 320,
            shouldMarkInitialViewportApplied: false,
        })).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: true,
            updateInitialViewportPendingObservation: true,
        });
    });

    it('returns no native initial viewport effects for inconsistent non-deferred non-marking inputs', () => {
        expect(resolveNativeSuccessfulBottomPinInitialViewportEffects({
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            offset: 320,
            shouldMarkInitialViewportApplied: false,
        })).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });
    });

    it('plans the measured native auto-follow command from measured metrics', () => {
        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200.9,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600.4,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'content-size-change',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).commandInput).toEqual({
            type: 'auto-follow',
            sessionId: 's1',
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'content-size-change',
            observedContentHeightPx: 1200.9,
            observedLayoutHeightPx: 600.4,
            skipNativeJsPin: false,
        });
    });

    it('plans JS-owned post-success bottom-pin records without stamping host time', () => {
        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'content-size-change',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).postSuccess.successfulBottomPinRecords).toEqual({
            automaticBottomPinCommandSessionId: 's1',
            bottomFollowPinCommand: {
                offsetY: 600,
                sessionId: 's1',
            },
            lastNativePinOffset: 600,
        });
    });

    it('plans native-maintenance post-success records for stream append without JS-owned bottom-pin records', () => {
        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'stream-append',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: true,
            wantsPinned: true,
        }).postSuccess).toMatchObject({
            streamAppendRecord: {
                contentHeight: 1200,
                sessionId: 's1',
            },
            successfulBottomPinRecords: {
                automaticBottomPinCommandSessionId: null,
                bottomFollowPinCommand: null,
                lastNativePinOffset: null,
            },
        });
    });

    it('plans one-shot materialization cleanup only after accepted content-size-change commands', () => {
        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'content-size-change',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).postSuccess.materializationCleanupDecision).toEqual({
            clearMaterializationAutoPin: true,
        });

        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'stream-append',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).postSuccess.materializationCleanupDecision).toEqual({
            clearMaterializationAutoPin: false,
        });
    });

    it('plans successful initial viewport effects for immediate and deferred native bottom-pin cases', () => {
        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: false,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'content-size-change',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: true,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).postSuccess.initialViewportEffects).toEqual({
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        });

        expect(resolveNativeMeasuredBottomPinCommandResultPlan({
            contentHeight: 1200,
            deferInitialViewportAppliedUntilObserved: true,
            invertedFirstPaintEstablishesBottom: false,
            isExplicitNativeCommand: false,
            layoutHeight: 600,
            offset: 600,
            pinThresholdPx: 80,
            reason: 'content-size-change',
            sessionId: 's1',
            shouldMarkInitialViewportApplied: false,
            skipAutomaticNativeJsPin: false,
            wantsPinned: true,
        }).postSuccess.initialViewportEffects).toEqual({
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: true,
            updateInitialViewportPendingObservation: true,
        });
    });

    it('blocks native initial follow-bottom when native maintenance, jump state, auto-follow, delay, or initial state disallows it', () => {
        const base = {
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasInitialViewportApplied: false,
            hasLastNativePinOffset: false,
            hasRearmedBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open' as const,
            usesNativeFlashListBottomMaintenance: true,
        };

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            usesNativeFlashListBottomMaintenance: false,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            isJumpToSeqActive: true,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            canAutoFollow: false,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            lastUserScrollIntentAtMs: 1500,
        })).toEqual({ type: 'blocked' });

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            hasInitialViewportApplied: true,
        })).toEqual({ type: 'blocked' });
    });

    it('treats initial-open as already owned when a pending bottom pin or previous native pin offset exists', () => {
        const base = {
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasInitialViewportApplied: false,
            hasLastNativePinOffset: false,
            hasRearmedBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open' as const,
            usesNativeFlashListBottomMaintenance: true,
        };

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            pendingMountSettleBottomPin: true,
        })).toEqual({ type: 'already-owned' });

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            hasLastNativePinOffset: true,
        })).toEqual({ type: 'already-owned' });
    });

    it('issues a measured pin for eligible initial and non-initial follow-bottom requests', () => {
        const expected = {
            force: true,
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: 'initial-open',
            type: 'issue-measured-pin',
        } as const;
        const base = {
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasInitialViewportApplied: false,
            hasLastNativePinOffset: false,
            hasRearmedBottomFollow: false,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 0,
            nowMs: 2000,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open' as const,
            usesNativeFlashListBottomMaintenance: true,
        };

        expect(resolveNativeInitialFollowBottomDecision(base)).toEqual(expected);

        expect(resolveNativeInitialFollowBottomDecision({
            ...base,
            hasLastNativePinOffset: true,
            pendingMountSettleBottomPin: true,
            reason: 'layout-change',
        })).toEqual({
            ...expected,
            telemetryReason: 'layout-change',
        });
    });

    it('lets native rearm bypass the recent user-intent delay for initial follow-bottom', () => {
        expect(resolveNativeInitialFollowBottomDecision({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasInitialViewportApplied: false,
            hasLastNativePinOffset: false,
            hasRearmedBottomFollow: true,
            isJumpToSeqActive: false,
            lastUserScrollIntentAtMs: 1500,
            nowMs: 2000,
            pendingMountSettleBottomPin: false,
            reason: 'initial-open',
            usesNativeFlashListBottomMaintenance: true,
        })).toEqual({
            force: true,
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: 'initial-open',
            type: 'issue-measured-pin',
        });
    });
});

import type { TranscriptViewportTelemetryObservationReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

import type { TranscriptScrollObservationHostPlan } from './scrollObservationHost';

export type ScrollObservationHostPlanContinuationInput = Readonly<{
    recentUserIntent: boolean;
    shouldApplyNativeMountSettlePassiveDriftRepinObservation: boolean;
}>;

export type ScrollObservationHostPlanApplierCallbacks = Readonly<{
    applyGenericScrollObservationAnchorCaptureCancellationEffects(
        effects: TranscriptScrollObservationHostPlan['genericEffects'],
    ): boolean;
    applyGenericScrollObservationReadOnlyVisibleBottomEffects(
        effects: TranscriptScrollObservationHostPlan['genericEffects'],
    ): boolean;
    applyGenericScrollObservationSuppressionEffects(
        effects: TranscriptScrollObservationHostPlan['genericEffects'],
    ): boolean;
    applyGenericScrollObservationViewportStateEffects(
        effects: TranscriptScrollObservationHostPlan['genericEffects'],
        options: Readonly<{
            recordAcceptedViewportPaintObservation: () => void;
        }>,
    ): boolean;
    applyNativeAcceptedViewportPaintEffects(
        effects: TranscriptScrollObservationHostPlan['acceptedViewportPaintEffects'],
    ): void;
    applyNativeBottomFollowCompletionEffects(
        effects: TranscriptScrollObservationHostPlan['nativeBottomFollowCompletionEffects'],
    ): void;
    applyNativeSettledReturnToLiveTailDrainEffects(
        effects: NonNullable<TranscriptScrollObservationHostPlan['nativeSettledReturnEffects']>['drainEffects'],
    ): void;
    applyNativeSettledReturnToLiveTailReturnEffects(
        effects: NonNullable<TranscriptScrollObservationHostPlan['nativeSettledReturnEffects']>['returnEffects'],
    ): boolean;
    applyNativeUserScrollTakeoverApplyEffects(
        effects: TranscriptScrollObservationHostPlan['nativeUserScrollTakeoverEffects'],
    ): void;
    applyWebUserScrollIntentTimestampLifecycleEffects(
        effects: TranscriptScrollObservationHostPlan['lifecycleEffects'],
    ): void;
    applyWebPassiveLiveTailCorrectionEffect(
        effect: NonNullable<TranscriptScrollObservationHostPlan['webPassiveLiveTailCorrectionEffect']>,
    ): boolean;
    applyWebUserScrollTakeoverLifecycleEffects(
        effects: TranscriptScrollObservationHostPlan['lifecycleEffects'],
    ): void;
    commitViewportLifecycleState(state: TranscriptScrollObservationHostPlan['state']): void;
    markNativeInitialViewportApplied(): void;
    recordNativeScrollObservation(reason: TranscriptViewportTelemetryObservationReason): void;
}>;

export function scrollObservationHostPlanRequestsNativePassiveDriftRepin(
    plan: TranscriptScrollObservationHostPlan,
): boolean {
    return plan.steps.some((step) =>
        step.type === 'native-passive-drift-bail' ||
        step.type === 'generic-fallback'
    );
}

export function applyScrollObservationHostPlan(input: Readonly<{
    callbacks: ScrollObservationHostPlanApplierCallbacks;
    continueAfterEarlyScrollObservation?: (input: ScrollObservationHostPlanContinuationInput) => void;
    plan: TranscriptScrollObservationHostPlan;
    recentUserIntentBeforeObservation: boolean;
}>): boolean {
    const { callbacks, plan } = input;
    const passiveObservationEffect = plan.nativePassiveScrollObservationEffect;
    if (passiveObservationEffect) {
        callbacks.recordNativeScrollObservation(passiveObservationEffect.reason);
    }
    if (plan.nativeBottomFollowCompletionEffects.length > 0) {
        callbacks.applyNativeBottomFollowCompletionEffects(plan.nativeBottomFollowCompletionEffects);
    }
    if (plan.nativeUserScrollTakeoverEffects.length > 0) {
        callbacks.applyNativeUserScrollTakeoverApplyEffects(plan.nativeUserScrollTakeoverEffects);
    }
    if (passiveObservationEffect?.markInitialViewportApplied === true) {
        callbacks.markNativeInitialViewportApplied();
    }
    if (passiveObservationEffect?.consumeAfterBottomCompletion === true) {
        return true;
    }

    input.continueAfterEarlyScrollObservation?.({
        recentUserIntent: passiveObservationEffect
            ? plan.recentUserIntent
            : input.recentUserIntentBeforeObservation,
        shouldApplyNativeMountSettlePassiveDriftRepinObservation:
            scrollObservationHostPlanRequestsNativePassiveDriftRepin(plan),
    });

    callbacks.commitViewportLifecycleState(plan.state);
    callbacks.applyWebUserScrollTakeoverLifecycleEffects(plan.lifecycleEffects);
    callbacks.applyWebUserScrollIntentTimestampLifecycleEffects(plan.lifecycleEffects);

    let consumed = plan.disposition === 'consumed';
    if (
        plan.webPassiveLiveTailCorrectionEffect &&
        callbacks.applyWebPassiveLiveTailCorrectionEffect(plan.webPassiveLiveTailCorrectionEffect)
    ) {
        consumed = true;
    }
    const settledReturnEffects = plan.nativeSettledReturnEffects;
    if (settledReturnEffects && settledReturnEffects.returnEffects.length > 0) {
        callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects);
        if (callbacks.applyNativeSettledReturnToLiveTailReturnEffects(settledReturnEffects.returnEffects)) {
            callbacks.applyNativeSettledReturnToLiveTailDrainEffects(settledReturnEffects.drainEffects);
            consumed = true;
        }
    }

    const recordAcceptedViewportPaintObservation = () => {
        callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects);
    };
    if (callbacks.applyGenericScrollObservationViewportStateEffects(plan.genericEffects, {
        recordAcceptedViewportPaintObservation,
    })) {
        consumed = true;
    }
    if (callbacks.applyGenericScrollObservationReadOnlyVisibleBottomEffects(plan.genericEffects)) {
        consumed = true;
    }
    if (callbacks.applyGenericScrollObservationSuppressionEffects(plan.genericEffects)) {
        consumed = true;
    }
    if (callbacks.applyGenericScrollObservationAnchorCaptureCancellationEffects(plan.genericEffects)) {
        consumed = true;
    }
    return consumed;
}

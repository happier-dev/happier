import type { TranscriptMeasurementHostContentSizeObservation } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type TranscriptLayoutContentSizeObservationPlatform = 'web' | 'ios' | 'android' | 'native-other' | string;
export type TranscriptContinuousFollowOwner = 'app' | 'renderer';

type ObservationMetrics = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

export type TranscriptLayoutObservationApplierEffects<TWebMetrics> = Readonly<{
    captureWebBottomFollowPreviousMetrics(): TWebMetrics | null;
    captureNativeBottomFollowPreviousFollow(): boolean;
    commitLayoutHeight(height: number): void;
    recordLayoutMeasuredTelemetry(input: ObservationMetrics): void;
    recordNativeVisibleWindowTelemetry(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change'>,
        input: ObservationMetrics,
    ): void;
    observeMountSettleMetrics(): void;
    pinNativeInitialFollowBottomViewportIfReady(reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change'>): void;
    observeNativePrependOwner(): void;
    observeWebPrependOwner(): void;
    runEntryRestoreAttempt(): void;
    verifyNativeSliceEntryRestoreTransaction(): void;
    requestAutomaticLiveTailPin(
        previousWebMetrics: TWebMetrics | null,
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change'>,
        nativePrevFollowAtBottom: boolean,
    ): void;
}>;

export type TranscriptContentSizeObservationApplierEffects<TWebMetrics> = Readonly<{
    prepareNativeContentMaterializationAutoPin(
        observation: Extract<TranscriptMeasurementHostContentSizeObservation, { status: 'measured' }>,
    ): void;
    captureWebBottomFollowPreviousMetrics(): TWebMetrics | null;
    captureNativeBottomFollowPreviousFollow(): boolean;
    commitContentHeight(height: number): void;
    observeNativeStreamAppendOffsetEscape(input: ObservationMetrics): void;
    recordContentMeasuredTelemetry(input: ObservationMetrics & Readonly<{
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>;
    }>): void;
    recordNativeVisibleWindowTelemetry(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>,
        input: ObservationMetrics,
    ): void;
    observeMountSettleMetrics(): void;
    pinNativeInitialFollowBottomViewportIfReady(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>,
    ): void;
    observeNativePrependOwner(): void;
    observeWebPrependOwner(): void;
    runEntryRestoreAttempt(): void;
    verifyNativeSliceEntryRestoreTransaction(): void;
    requestAutomaticLiveTailPin(
        previousWebMetrics: TWebMetrics | null,
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>,
        nativePrevFollowAtBottom: boolean,
    ): void;
}>;

export function applyTranscriptLayoutObservation<TWebMetrics>(
    input: Readonly<{
        contentHeight: number;
        continuousFollowOwner?: TranscriptContinuousFollowOwner;
        layoutHeight: number;
        layoutHeightChanged: boolean;
        platformOS: TranscriptLayoutContentSizeObservationPlatform;
        shouldRestoreNativeEntry: boolean;
    }>,
    effects: TranscriptLayoutObservationApplierEffects<TWebMetrics>,
): boolean {
    if (!Number.isFinite(input.layoutHeight)) return false;

    const appOwnsContinuousFollow = input.continuousFollowOwner !== 'renderer';
    const previousWebMetrics = appOwnsContinuousFollow
        ? effects.captureWebBottomFollowPreviousMetrics()
        : null;
    const nativePrevFollowAtBottom = appOwnsContinuousFollow
        ? effects.captureNativeBottomFollowPreviousFollow()
        : false;
    effects.commitLayoutHeight(input.layoutHeight);
    if (input.layoutHeightChanged) {
        effects.recordLayoutMeasuredTelemetry({
            contentHeight: input.contentHeight,
            layoutHeight: input.layoutHeight,
        });
    }
    effects.recordNativeVisibleWindowTelemetry('layout-change', {
        contentHeight: input.contentHeight,
        layoutHeight: input.layoutHeight,
    });
    effects.observeMountSettleMetrics();
    if (appOwnsContinuousFollow) {
        effects.pinNativeInitialFollowBottomViewportIfReady('layout-change');
    }

    if (appOwnsContinuousFollow) {
        if (input.platformOS === 'web') {
            effects.observeWebPrependOwner();
        } else {
            effects.observeNativePrependOwner();
        }
    }
    if (input.platformOS !== 'web' && input.shouldRestoreNativeEntry) {
        effects.runEntryRestoreAttempt();
        effects.verifyNativeSliceEntryRestoreTransaction();
    }

    if (appOwnsContinuousFollow && input.layoutHeightChanged && input.contentHeight > 0) {
        effects.requestAutomaticLiveTailPin(previousWebMetrics, 'layout-change', nativePrevFollowAtBottom);
    }
    return true;
}

export function applyTranscriptContentSizeObservation<TWebMetrics>(
    input: Readonly<{
        continuousFollowOwner?: TranscriptContinuousFollowOwner;
        layoutHeight: number;
        observation: TranscriptMeasurementHostContentSizeObservation;
        platformOS: TranscriptLayoutContentSizeObservationPlatform;
        shouldRestoreNativeEntry: boolean;
    }>,
    effects: TranscriptContentSizeObservationApplierEffects<TWebMetrics>,
): boolean {
    if (input.observation.status !== 'measured') return false;

    const observation = input.observation;
    const reason = observation.reason;
    const appOwnsContinuousFollow = input.continuousFollowOwner !== 'renderer';
    effects.prepareNativeContentMaterializationAutoPin(observation);
    const previousWebMetrics = appOwnsContinuousFollow
        ? effects.captureWebBottomFollowPreviousMetrics()
        : null;
    const nativePrevFollowAtBottom = appOwnsContinuousFollow
        ? effects.captureNativeBottomFollowPreviousFollow()
        : false;
    effects.commitContentHeight(observation.measuredContentHeight);

    const metrics = {
        contentHeight: observation.measuredContentHeight,
        layoutHeight: input.layoutHeight,
    };
    if (
        appOwnsContinuousFollow &&
        input.platformOS !== 'web' &&
        observation.contentHeightChanged &&
        reason === 'stream-append'
    ) {
        effects.observeNativeStreamAppendOffsetEscape(metrics);
    }
    if (observation.contentHeightChanged) {
        effects.recordContentMeasuredTelemetry({ ...metrics, reason });
    }
    effects.recordNativeVisibleWindowTelemetry(reason, metrics);
    effects.observeMountSettleMetrics();
    if (appOwnsContinuousFollow) {
        effects.pinNativeInitialFollowBottomViewportIfReady(reason);
    }

    if (appOwnsContinuousFollow) {
        if (input.platformOS === 'web') {
            effects.observeWebPrependOwner();
        } else {
            effects.observeNativePrependOwner();
        }
    }
    if (input.platformOS !== 'web' && input.shouldRestoreNativeEntry) {
        effects.runEntryRestoreAttempt();
        effects.verifyNativeSliceEntryRestoreTransaction();
    }

    if (appOwnsContinuousFollow && observation.contentHeightChanged && input.layoutHeight > 0) {
        effects.requestAutomaticLiveTailPin(previousWebMetrics, reason, nativePrevFollowAtBottom);
    }
    return true;
}

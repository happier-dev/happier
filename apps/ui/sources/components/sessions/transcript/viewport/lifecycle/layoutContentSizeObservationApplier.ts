import type { TranscriptMeasurementHostContentSizeObservation } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type TranscriptLayoutContentSizeObservationPlatform = 'web' | 'ios' | 'android' | 'native-other' | string;

type ObservationMetrics = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

export type TranscriptLayoutObservationApplierEffects = Readonly<{
    commitLayoutHeight(height: number): void;
    recordLayoutMeasuredTelemetry(input: ObservationMetrics): void;
    recordNativeVisibleWindowTelemetry(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change'>,
        input: ObservationMetrics,
    ): void;
    observeMountSettleMetrics(): void;
    runEntryRestoreAttempt(): void;
}>;

export type TranscriptContentSizeObservationApplierEffects = Readonly<{
    commitContentHeight(height: number): void;
    recordContentMeasuredTelemetry(input: ObservationMetrics & Readonly<{
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>;
    }>): void;
    recordNativeVisibleWindowTelemetry(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'stream-append'>,
        input: ObservationMetrics,
    ): void;
    observeMountSettleMetrics(): void;
    runEntryRestoreAttempt(): void;
}>;

export function applyTranscriptLayoutObservation(
    input: Readonly<{
        contentHeight: number;
        layoutHeight: number;
        layoutHeightChanged: boolean;
        platformOS: TranscriptLayoutContentSizeObservationPlatform;
        shouldRestoreNativeEntry: boolean;
    }>,
    effects: TranscriptLayoutObservationApplierEffects,
): boolean {
    if (!Number.isFinite(input.layoutHeight)) return false;

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
    if (input.platformOS !== 'web' && input.shouldRestoreNativeEntry) {
        effects.runEntryRestoreAttempt();
    }
    return true;
}

export function applyTranscriptContentSizeObservation(
    input: Readonly<{
        layoutHeight: number;
        observation: TranscriptMeasurementHostContentSizeObservation;
        platformOS: TranscriptLayoutContentSizeObservationPlatform;
        shouldRestoreNativeEntry: boolean;
    }>,
    effects: TranscriptContentSizeObservationApplierEffects,
): boolean {
    if (input.observation.status !== 'measured') return false;

    const observation = input.observation;
    const reason = observation.reason;
    effects.commitContentHeight(observation.measuredContentHeight);

    const metrics = {
        contentHeight: observation.measuredContentHeight,
        layoutHeight: input.layoutHeight,
    };
    if (observation.contentHeightChanged) {
        effects.recordContentMeasuredTelemetry({ ...metrics, reason });
    }
    effects.recordNativeVisibleWindowTelemetry(reason, metrics);
    effects.observeMountSettleMetrics();
    if (input.platformOS !== 'web' && input.shouldRestoreNativeEntry) {
        effects.runEntryRestoreAttempt();
    }
    return true;
}

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import type {
    TranscriptMeasurementReconciler,
    TranscriptRowHeightReservation,
} from './transcriptMeasurementReconciler';
import { isStructuralSignatureDelta } from './transcriptMeasurementReconciler';

/**
 * C1: the row-shell reservation is sourced from the single measurement reconciler. Stable rows get
 * an `exact` reservation (== the last measured height); streaming/prepended/never-measured rows get
 * a monotonic `floor` (>= the last measured height, never over-reserving on append). The `kind` makes
 * the floor-vs-exact invariant type-visible so a reservation can never compete with FlashList's
 * authoritative onLayout measurement. No FlashList estimate props are ever exposed.
 */
export function resolveTranscriptRowShellHeight(params: Readonly<{
    previousSignature?: TranscriptItemHeightValiditySignature;
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
}>): TranscriptRowHeightReservation | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (
        reservation?.kind === 'floor' &&
        params.previousSignature !== undefined &&
        isStructuralSignatureDelta(params.previousSignature, params.signature)
    ) {
        return undefined;
    }
    return reservation;
}

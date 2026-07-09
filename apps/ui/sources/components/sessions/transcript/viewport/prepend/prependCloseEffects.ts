import type { PrependCorrectorCoverage } from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';
import type { PrependTransactionOutcome } from '@/components/sessions/transcript/viewport/prepend/prependTransaction';

export type NativePrependCloseSnapshot = Readonly<{
    activeOwnerIsPrepend: boolean;
    anchorDeltaPx: number | null;
    anchorItemOffsetPx: number;
    correctorCoverage: PrependCorrectorCoverage;
    outcome: PrependTransactionOutcome | null;
    sessionId: string;
}>;

export type NativePrependCloseEffect =
    | Readonly<{
        outcome: PrependTransactionOutcome;
        type: 'close-prepend-ownership';
    }>
    | Readonly<{
        anchorDeltaPx?: number;
        anchorItemOffsetPx: number;
        correctorAppliedDiffTotalPx: number;
        correctorEventCount: number;
        mode: 'restore-anchor';
        reason: PrependTransactionOutcome;
        sessionId: string;
        type: 'restore-decision-for-session';
    }>;

export function resolveNativePrependCloseEffects(
    snapshot: NativePrependCloseSnapshot,
): readonly NativePrependCloseEffect[] {
    const outcome = snapshot.outcome ?? 'abandoned-identity';
    const telemetryEffect: NativePrependCloseEffect = {
        ...(snapshot.anchorDeltaPx == null ? {} : { anchorDeltaPx: snapshot.anchorDeltaPx }),
        anchorItemOffsetPx: snapshot.anchorItemOffsetPx,
        correctorAppliedDiffTotalPx: snapshot.correctorCoverage.appliedDiffTotalPx,
        correctorEventCount: snapshot.correctorCoverage.eventCount,
        mode: 'restore-anchor',
        reason: outcome,
        sessionId: snapshot.sessionId,
        type: 'restore-decision-for-session',
    };
    if (!snapshot.activeOwnerIsPrepend) {
        return [telemetryEffect];
    }
    return [
        {
            outcome,
            type: 'close-prepend-ownership',
        },
        telemetryEffect,
    ];
}

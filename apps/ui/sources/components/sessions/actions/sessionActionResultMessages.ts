import type { SessionBulkActionExecutionResult } from './sessionBulkActionTypes';

export type SessionBulkActionResultSummary = Readonly<{
    kind: 'success' | 'partial' | 'failed' | 'skipped' | 'cancelled' | 'empty';
    targetCount: number;
    succeededCount: number;
    failedCount: number;
    skippedCount: number;
    cancelledCount: number;
    remainingSelectedKeys: readonly string[];
}>;

export function buildSessionBulkActionResultSummary(
    result: SessionBulkActionExecutionResult,
): SessionBulkActionResultSummary {
    const succeededCount = result.succeeded.length;
    const failedCount = result.failed.length;
    const skippedCount = result.skipped.length;
    const cancelledCount = result.cancelled.length;
    const unresolvedCount = failedCount + skippedCount + cancelledCount;

    let kind: SessionBulkActionResultSummary['kind'];
    if (result.targetCount === 0) {
        kind = 'empty';
    } else if (succeededCount > 0 && unresolvedCount === 0) {
        kind = 'success';
    } else if (succeededCount > 0) {
        kind = 'partial';
    } else if (cancelledCount > 0) {
        kind = 'cancelled';
    } else if (failedCount > 0) {
        kind = 'failed';
    } else {
        kind = 'skipped';
    }

    return {
        kind,
        targetCount: result.targetCount,
        succeededCount,
        failedCount,
        skippedCount,
        cancelledCount,
        remainingSelectedKeys: result.remainingSelectedKeys,
    };
}

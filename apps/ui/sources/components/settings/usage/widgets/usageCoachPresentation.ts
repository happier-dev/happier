import { isUsageCoachUndoActionIdV1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import type { UsageCoachFinding } from '@happier-dev/protocol/usage/coach/coachFinding';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UsageCoachSnapshot } from './usageCoachController';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { readUsageCoverageGaps } from './usageBodyKit';

export function readUsageCoachFailureMessage(error: NonNullable<UsageCoachSnapshot['error']>): 'usage.board.coach.undoConflict' | 'usage.board.coach.actionFailed' {
  const code = error.failure.errorCode === 'coach_owner_refused'
    ? readActionErrorCodeV1(error.failure.details) : error.failure.errorCode;
  return isUsageCoachUndoActionIdV1(error.actionId) && code?.endsWith('conflict')
    ? 'usage.board.coach.undoConflict' : 'usage.board.coach.actionFailed';
}

/** Evidence activity is independent of whether a previous evaluation is retained as stale. */
export function readUsageCoachState(slice: UsageQueryResultSlice): 'reading' | 'ready' | 'unavailable' {
  const sources = slice.shownQuery.includeSessionEvidence ? ['accounting', 'how_you_work'] : ['accounting'];
  if (readUsageCoverageGaps(slice, sources).some(source => source.status === 'pending' || source.status === 'not_loaded'))
    return 'reading';
  return slice.coach ? 'ready' : 'unavailable';
}

/** Project the mounted rows from finding state and acknowledged Action receipts. */
export function projectUsageCoachFindings(findings: readonly UsageCoachFinding[], snapshot: UsageCoachSnapshot, nowMs: number) {
  const visible = findings.filter(finding => !finding.state.dismissed
    && !(finding.state.snoozedUntilMs !== null && finding.state.snoozedUntilMs > nowMs));
  return { visible, suppressed: findings.filter(finding => !visible.includes(finding)),
    appliedOnly: snapshot.applied.filter(entry => !visible.some(finding => finding.evidenceKey === entry.evidenceKey)) };
}

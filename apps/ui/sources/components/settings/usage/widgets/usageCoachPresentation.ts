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

type UsageCoachEvidenceSeries = NonNullable<UsageCoachFinding['evidenceSeries']>[number];

/**
 * A finding's measured samples as a sparkline a narrow column can carry: the samples fold into at most `buckets`
 * equal spans of time, each keeping its largest sample, so a dense series reads as its envelope and no peak is
 * lost. The one figure under the line is the series' largest sample (the latest can be a meaningless zero).
 * A single sample, or samples at one instant, are an observation, not a trend.
 */
export function projectUsageCoachTrend(series: Pick<UsageCoachEvidenceSeries, 'metric' | 'unit' | 'points'>, buckets: number) {
  const { points } = series;
  const first = points[0]?.observedAtMs;
  const last = points[points.length - 1]?.observedAtMs;
  if (points.length < 2 || first === undefined || last === undefined || last <= first) return null;
  const span = (last - first) / buckets;
  const kept = new Map<number, UsageCoachEvidenceSeries['points'][number]>();
  let peak = points[0]!;
  for (const point of points) {
    const bucket = Math.min(buckets - 1, Math.floor((point.observedAtMs - first) / span));
    const held = kept.get(bucket);
    if (!held || point.value > held.value) kept.set(bucket, point);
    if (point.value > peak.value) peak = point;
  }
  const folded = [...kept.entries()].sort(([left], [right]) => left - right)
    .map(([, point]) => ({ id: point.evidenceId, x: point.observedAtMs, y: point.value }));
  return { points: folded, peak: { value: peak.value, observedAtMs: peak.observedAtMs } };
}

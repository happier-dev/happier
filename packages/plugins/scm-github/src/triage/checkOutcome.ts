export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);
export const NEUTRAL_CONCLUSIONS: ReadonlySet<string> = new Set(['neutral', 'skipped', 'cancelled', 'stale']);

/** Normalize native commit statuses before applying the single check outcome policy. */
export function readGithubStatusContextObservationV1(state: string | null | undefined): Readonly<{
  status: 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | null;
}> {
  const native = state?.toLowerCase();
  return {
    status: native === 'pending' || native === 'expected' ? 'in_progress' : 'completed',
    conclusion: native === 'success' ? 'success' : native === 'failure' || native === 'error' ? 'failure' : null,
  };
}

function isGithubFailingCheckConclusion(value: string | undefined | null): boolean {
  return value !== undefined && value !== null && FAILING_CONCLUSIONS.has(value);
}

/** Browser-safe provider outcome shared by rollups and detail projections. */
export function readGithubCheckOutcomeV1(
  observation: Readonly<{ status: string; conclusion?: string | null }>,
): 'passed' | 'failed' | 'pending' | 'neutral' | 'unknown' {
  if (observation.status !== 'completed') return 'pending';
  if (isGithubFailingCheckConclusion(observation.conclusion)) return 'failed';
  if (observation.conclusion === 'success') return 'passed';
  if (observation.conclusion != null && NEUTRAL_CONCLUSIONS.has(observation.conclusion)) return 'neutral';
  return 'unknown';
}

import type { CheckStatusKind } from '@happier-dev/plugin-ui';
import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { readGithubCheckOutcomeV1 } from '../../triage/checkOutcome.js';

/**
 * The shared check mark for GitHub's own status of one check. The outcome owner decides failed, passed and
 * pending; the mark only says which kind of pending or settled-without-a-verdict it is.
 */
export function githubCheckStatusKindV1(row: Pick<GithubProjectedCheckRowV1, 'status' | 'conclusion'>): CheckStatusKind {
  const outcome = readGithubCheckOutcomeV1(row);
  if (outcome === 'failed' || outcome === 'passed' || outcome === 'unknown') return outcome;
  if (outcome === 'pending') {
    return row.status === 'in_progress' ? 'running' : row.status === 'waiting' ? 'waiting' : 'queued';
  }
  return row.conclusion === 'skipped' ? 'skipped' : row.conclusion === 'cancelled' ? 'cancelled' : 'neutral';
}

/** The tone of the overview's state word ("Open", "Merged", "Draft", ...). */
export function githubOverviewStatusToneV1(label: string): 'secondary' | 'muted' | 'neutral' {
  // Open and done are quiet, a draft quieter still; none of them needs the reader.
  if (label === 'Merged' || label === 'Open') return 'secondary';
  if (label === 'Draft') return 'muted';
  return 'neutral';
}

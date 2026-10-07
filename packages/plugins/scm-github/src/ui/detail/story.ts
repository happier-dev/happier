import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { readGithubCheckOutcomeV1 } from '../../triage/checkOutcome.js';

/** The tone a Checks panel row draws for GitHub's own outcome of that check. */

export function githubCheckToneV1(row: GithubProjectedCheckRowV1): 'danger' | 'neutral' {
  // Healthy says nothing and running is not a caution: only a failure colours the row.
  return readGithubCheckOutcomeV1(row) === 'failed' ? 'danger' : 'neutral';
}

/** The tone of the overview's state word ("Open", "Merged", "Draft", ...). */
export function githubOverviewStatusToneV1(label: string): 'secondary' | 'muted' | 'neutral' {
  // Open and done are quiet, a draft quieter still; none of them needs the reader.
  if (label === 'Merged' || label === 'Open') return 'secondary';
  if (label === 'Draft') return 'muted';
  return 'neutral';
}

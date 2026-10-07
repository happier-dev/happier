import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { readGithubCheckOutcomeV1 } from '../../triage/checkOutcome.js';

/** The tone a Checks panel row draws for GitHub's own outcome of that check. */

export function githubCheckToneV1(row: GithubProjectedCheckRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  const outcome = readGithubCheckOutcomeV1(row);
  if (outcome === 'passed') return 'success';
  if (outcome === 'failed') return 'danger';
  if (outcome === 'pending') return 'warning';
  return 'neutral';
}

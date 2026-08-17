import type { GithubTriageEntryStateV1 } from '../types.js';

/**
 * `presentation` is a lossy projection; `nativeLabel` keeps GitHub's own word so the
 * user reads the provider's vocabulary rather than ours.
 *
 * `suppressed` is never produced by a forge — it belongs to error sources. A closed,
 * merged or not-planned item is `present` with a state; it is never absence.
 */

function readState(raw: Readonly<Record<string, unknown>>): string | null {
  return typeof raw.state === 'string' && raw.state.trim() ? raw.state.trim() : null;
}

export function mapGithubPullRequestState(
  raw: Readonly<Record<string, unknown>>,
): GithubTriageEntryStateV1 {
  const state = readState(raw);
  if (state === 'open') {
    return raw.draft === true
      ? Object.freeze({ presentation: 'active', nativeLabel: 'Draft' })
      : Object.freeze({ presentation: 'active', nativeLabel: 'Open' });
  }
  if (state === 'closed') {
    // A merged pull request is closed AND merged; folding the two loses the outcome the
    // user actually asked about.
    return typeof raw.merged_at === 'string' && raw.merged_at.trim()
      ? Object.freeze({ presentation: 'closed', nativeLabel: 'Merged' })
      : Object.freeze({ presentation: 'closed', nativeLabel: 'Closed' });
  }
  return Object.freeze({ presentation: 'unknown', nativeLabel: state ?? '' });
}

export function mapGithubIssueState(
  raw: Readonly<Record<string, unknown>>,
): GithubTriageEntryStateV1 {
  const state = readState(raw);
  if (state === 'open') {
    return Object.freeze({ presentation: 'active', nativeLabel: 'Open' });
  }
  if (state === 'closed') {
    const reason = typeof raw.state_reason === 'string' ? raw.state_reason.trim() : '';
    // `completed` is a resolution; `not_planned` is a dismissal. They are different
    // outcomes and the aggregate lanes them differently.
    if (reason === 'completed') {
      return Object.freeze({ presentation: 'resolved', nativeLabel: 'Closed as completed' });
    }
    if (reason === 'not_planned') {
      return Object.freeze({ presentation: 'closed', nativeLabel: 'Closed as not planned' });
    }
    return Object.freeze({ presentation: 'closed', nativeLabel: 'Closed' });
  }
  return Object.freeze({ presentation: 'unknown', nativeLabel: state ?? '' });
}

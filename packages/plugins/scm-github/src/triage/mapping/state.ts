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
    // A merged pull request completed its purpose: `resolved`, exactly as a completed
    // issue is. Closed without merging is `closed` (`CONTRACT.md` §4, r0.42).
    const pullRequest = typeof raw.pull_request === 'object' && raw.pull_request !== null
      && !Array.isArray(raw.pull_request)
      ? raw.pull_request as Readonly<Record<string, unknown>> : null;
    const mergedAt = raw.merged_at ?? pullRequest?.merged_at;
    return typeof mergedAt === 'string' && mergedAt.trim()
      ? Object.freeze({ presentation: 'resolved', nativeLabel: 'Merged' })
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
      return Object.freeze({ presentation: 'resolved', nativeLabel: 'Closed as completed', completionReason: 'completed' });
    }
    if (reason === 'not_planned') {
      return Object.freeze({ presentation: 'closed', nativeLabel: 'Closed as not planned', completionReason: 'canceled' });
    }
    return Object.freeze({ presentation: 'closed', nativeLabel: 'Closed' });
  }
  return Object.freeze({ presentation: 'unknown', nativeLabel: state ?? '' });
}

/**
 * `Computing` is a REAL GitHub state: mergeability is asynchronously derived and
 * `mergeable` is `null` until GitHub finishes. It means "ask again shortly" and must not
 * be collapsed into unresolved, which means "we cannot determine this at all".
 */
export function mapGithubMergeability(
  raw: Readonly<Record<string, unknown>>,
): 'conflicts' | 'blocked' | 'computing' | null {
  const state = typeof raw.mergeable_state === 'string' ? raw.mergeable_state.trim() : '';
  if (raw.draft === true || state === 'draft') return 'blocked';
  if (raw.mergeable === false || state === 'dirty') return 'conflicts';
  if (state === 'blocked') return 'blocked';
  if (raw.mergeable === null || state === 'unknown' || state === '') return 'computing';
  return null;
}

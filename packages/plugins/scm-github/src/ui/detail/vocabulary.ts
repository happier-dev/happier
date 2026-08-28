/**
 * This source's own words for GitHub's own vocabulary, and the catalog keys
 * they resolve through.
 *
 * Three tables live here because they are one rule: GitHub names a fact in its
 * vocabulary — a row-fact id, a timeline event kind, a review state — and this
 * surface says it in the reader's language, falling back to the declared
 * English when a locale has no entry and to GitHub's own word when this build
 * models the value at all.
 *
 * They are together, and out of the renderer, for one concrete reason: every
 * key here is COMPUTED at the call site from a provider value, so a scan for
 * key literals cannot see them. A guard can only prove a locale carries them if
 * the tables and their key derivation are one importable thing. When the words
 * sat in the renderer and the key was derived beside them, nothing could
 * falsify "every field label is translated".
 *
 * A value absent from a table is not an error: it means this build has no
 * sentence of its own for it, and the caller renders GitHub's word instead of
 * inventing one.
 */

/** The fact vocabulary `triage/mapping/facts.ts` emits, in this surface's words. */
export const GITHUB_DETAIL_FIELD_LABELS_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    'github/number': 'Number',
    'github/repository': 'Repository',
    'github/author': 'Author',
    'github/updated': 'Updated',
    'github/comments': 'Comments',
    'github/labels': 'Labels',
    'github/review-decision': 'Review',
    'github/checks': 'Checks',
    'github/mergeability': 'Mergeability',
    'github/additions-deletions': 'Changes',
  });

export function githubDetailFieldLabelKey(factId: string): string {
  return `plugins.github.ui.field.${factId.replace(/^github\//u, '').replace(/-/gu, '_')}`;
}

/**
 * The event kinds this build has a sentence for.
 *
 * `forcePushed` and `baseChanged` read differently from an ordinary push on
 * purpose: both silently invalidate work computed against the previous head or
 * base, and a reader scanning the timeline is exactly who needs to notice.
 */
export const GITHUB_TIMELINE_HEADLINES_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    commented: 'Commented',
    committed: 'Pushed a commit',
    forcePushed: 'Force-pushed the head branch',
    baseChanged: 'Changed the base branch',
    reviewed: 'Reviewed',
    reviewRequested: 'Requested a review',
    reviewRequestRemoved: 'Removed a review request',
    merged: 'Merged',
    closed: 'Closed',
    reopened: 'Reopened',
    labeled: 'Added a label',
    unlabeled: 'Removed a label',
    assigned: 'Assigned',
    unassigned: 'Unassigned',
    milestoned: 'Added to a milestone',
    demilestoned: 'Removed from a milestone',
    renamed: 'Renamed',
    referenced: 'Referenced',
    crossReferenced: 'Cross-referenced',
  });

export function githubTimelineHeadlineKey(kind: string): string {
  return `plugins.github.ui.event.${kind}`;
}

/**
 * GitHub's review-state words, keyed by GitHub's own spelling.
 *
 * Keyed by the provider vocabulary rather than a private one, so a state this
 * build has never seen keeps GitHub's word rather than disappearing or being
 * described as something it is not.
 */
export const GITHUB_REVIEW_STATE_LABELS_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    approved: 'Approved',
    changes_requested: 'Changes requested',
    commented: 'Commented',
    dismissed: 'Dismissed',
    pending: 'Not submitted yet',
  });

export function githubReviewStateKey(state: string): string {
  return `plugins.github.ui.reviewState.${state}`;
}

/** Provider status words this build can present in the reader's language. */
export const GITHUB_CHANGED_FILE_STATUS_LABELS_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({ modified: 'Modified', renamed: 'Renamed' });
export const GITHUB_CHECK_STATUS_LABELS_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    completed: 'Completed',
    in_progress: 'In progress',
    queued: 'Queued',
    waiting: 'Waiting',
    requested: 'Requested',
    pending: 'Pending',
  });
export const GITHUB_CHECK_CONCLUSION_LABELS_V1: Readonly<Record<string, string | undefined>> =
  Object.freeze({ success: 'Succeeded', failure: 'Failed', skipped: 'Skipped' });

export function githubChangedFileStatusKey(status: string): string {
  return `plugins.github.ui.fileStatus.${status}`;
}
export function githubCheckStatusKey(status: string): string {
  return `plugins.github.ui.checkStatus.${status}`;
}
export function githubCheckConclusionKey(conclusion: string): string {
  return `plugins.github.ui.checkConclusion.${conclusion}`;
}

/**
 * The word for a review GitHub returned without a state.
 *
 * It says only that a review happened, because that is all such a row proves.
 */
export const GITHUB_REVIEW_STATE_UNKNOWN_KEY_V1 = 'plugins.github.ui.reviewState.unknown';
export const GITHUB_REVIEW_STATE_UNKNOWN_LABEL_V1 = 'Reviewed';

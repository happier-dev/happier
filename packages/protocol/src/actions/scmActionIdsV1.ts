export const SCM_WORKTREE_CREATE_ACTION_ID_V1 = 'scm.worktree.create' as const;
export const SCM_WORKTREE_REMOVE_ACTION_ID_V1 = 'scm.worktree.remove' as const;

/** Retained evidence uses its Session id as a shelf namespace, not a live target.
 * Placement classification never grants access; the receiving SCM owner still
 * admits the requester and opens the exact saved result or comparison.
 */
export function isStoredScmReviewEvidenceAction(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
  return actionId.startsWith('scm.') && (
    actionId === 'scm.diff.file' && typeof input.captured === 'object' && input.captured !== null
    || actionId.startsWith('scm.diffSummary.result.')
    || typeof input.resultId === 'string' && (actionId.startsWith('scm.diffSummary.commitPlan.')
      || actionId === 'scm.diffSummary.refine' || actionId === 'scm.diffSummary.addOutputs'
      || actionId === 'scm.diffSummary.discuss' || actionId === 'scm.diffSummary.reviewed.mark'
      || actionId === 'scm.diffSummary.reviewed.unmark')
    || typeof input.comparisonId === 'string' && input.comparisonId.length > 0
      && (actionId === 'scm.diffSummary.capture'
        || actionId === 'scm.diffSummary.reviewed.unmark' && input.v === 2 && input.reset === true));
}

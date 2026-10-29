/** Machine-retained review evidence survives its generator Session, including marks-only recovery.
 * This is placement classification, never authority: the caller must still prove current
 * custodian custody and the native owner must load the exact saved result/capture.
 */
export function isStoredScmReviewEvidenceAction(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
    return actionId.startsWith('scm.diffSummary.result.') || typeof input.resultId === 'string'
        || typeof input.comparisonId === 'string' && input.comparisonId.length > 0
            && (actionId === 'scm.diffSummary.capture'
                || actionId === 'scm.diffSummary.reviewed.unmark' && input.v === 2 && input.reset === true);
}

/** Retained evidence/revisions keep their existing local access/currentness owner. */
export function isRetainedScmReviewAction(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
    return isStoredScmReviewEvidenceAction(actionId, input)
        || actionId === 'scm.diffSummary.refine' || actionId === 'scm.diffSummary.addOutputs'
        || actionId === 'scm.diffSummary.discuss'
        || ((actionId === 'scm.diffSummary.reviewed.mark' || actionId === 'scm.diffSummary.reviewed.unmark')
            && !('changeKeys' in input));
}

/** Session placement replaces authored cwd with the admitted host workspace. */
export function bindScmActionToSessionWorkspace(actionId: string, input: Readonly<Record<string, unknown>>,
    workingDirectory: string, sessionId: string): Readonly<Record<string, unknown>> {
    return actionId === 'scm.repository.clone' ? input
        : actionId === 'scm.pullRequest.prepareWorktree' ? { ...input, cwd: workingDirectory, sourcePath: workingDirectory }
            : { ...input, cwd: workingDirectory, ...(actionId === 'scm.diffSummary.capture' ? { sessionId } : {}) };
}

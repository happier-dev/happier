import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

/** Machine-retained review evidence survives its generator Session, including marks-only recovery.
 * This is placement classification, never authority: the caller must still prove current
 * custodian custody and the native owner must load the exact saved result/capture.
 */
export function isStoredScmReviewEvidenceAction(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
    return actionId === 'scm.diff.file' && typeof input.captured === 'object' && input.captured !== null
        || actionId.startsWith('scm.diffSummary.result.') || typeof input.resultId === 'string'
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

/** Live reads can select a child worktree within the admitted host workspace.
 * Writes and retained evidence keep their existing Session placement.
 * The filesystem owner resolves symlinks; authored paths never expand scope.
 */
export function bindScmActionToSessionWorkspace(actionId: ActionId, input: Readonly<Record<string, unknown>>,
    workingDirectory: string, sessionId: string): Readonly<Record<string, unknown>> {
    const cwd = getActionSpec(actionId).sideEffectClass === 'read'
        && !isRetainedScmReviewAction(actionId, input) && typeof input.cwd === 'string'
        ? input.cwd : workingDirectory;
    return actionId === 'scm.repository.clone' ? input
        : actionId === 'scm.pullRequest.prepareWorktree' ? { ...input, cwd: workingDirectory, sourcePath: workingDirectory }
            : { ...input, cwd, ...(actionId === 'scm.diffSummary.capture' ? { sessionId } : {}),
                ...(actionId === 'scm.diff.file' && typeof input.captured === 'object' && input.captured !== null
                    ? { captured: { ...input.captured, sessionId } } : {}) };
}

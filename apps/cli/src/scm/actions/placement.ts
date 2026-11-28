import { isScmLocalRepositoryReadRpcMethod } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isStoredScmReviewEvidenceAction } from '@happier-dev/protocol/actions/scmActionIdsV1';
export { isStoredScmReviewEvidenceAction } from '@happier-dev/protocol/actions/scmActionIdsV1';

/** Comparison capture stores evidence and can use custody from the authenticated local Machine owner. */
export function canUseAuthenticatedLocalRequesterForScmRpc(method: string): boolean {
    return isScmLocalRepositoryReadRpcMethod(method) || method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE;
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

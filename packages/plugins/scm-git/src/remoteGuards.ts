import type { ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import {
  evaluateScmRemoteMutationPreconditions as evaluateSharedRemoteMutationPreconditions,
  SCM_OPERATION_ERROR_CODES,
  type ScmRemoteMutationGuardResult,
  type ScmRemoteMutationKind,
  type ScmRemoteMutationReason,
} from '@happier-dev/plugin-sdk/scm';

type RemoteMutationKind = 'push' | 'pull';

export function evaluateRemoteMutationPreconditions(input: {
    kind: RemoteMutationKind;
    snapshot: ScmWorkingSnapshot;
    hasExplicitRemoteOrBranch: boolean;
}): ScmRemoteMutationGuardResult {
    return evaluateSharedRemoteMutationPreconditions({
        kind: input.kind,
        snapshot: input.snapshot,
        hasExplicitTarget: input.hasExplicitRemoteOrBranch,
        policy: {
            requireUpstreamWhenNoExplicitTarget: true,
            requireActiveHead: false,
            blockPushOnConflicts: true,
            blockPushWhenBehind: true,
            requireCleanPull: true,
        },
        mapReasonToError: mapRemoteMutationReasonToError,
    });
}

function mapRemoteMutationReasonToError(
    kind: ScmRemoteMutationKind,
    reason: ScmRemoteMutationReason
): Exclude<ScmRemoteMutationGuardResult, { ok: true }> {
    switch (reason) {
        case 'conflicts_present':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                error: 'Resolve conflicts before pushing.',
            };
        case 'upstream_required':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                error: kind === 'push' ? 'Set an upstream branch before push.' : 'Set an upstream branch before pull.',
            };
        case 'detached_head':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: kind === 'push'
                    ? 'Push is unavailable while HEAD is detached'
                    : 'Pull is unavailable while HEAD is detached',
            };
        case 'branch_behind_remote':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                error: 'Local branch is behind upstream. Pull before pushing.',
            };
        case 'clean_worktree_required':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                error: 'Working tree must be clean before pull',
            };
        default:
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Remote operation preconditions failed',
            };
    }
}

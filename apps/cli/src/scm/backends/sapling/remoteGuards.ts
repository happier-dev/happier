import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import {
    SCM_OPERATION_ERROR_CODES,
    type ScmRemoteMutationKind,
    type ScmRemoteMutationReason,
} from '@happier-dev/protocol';
import {
    evaluateRemoteMutationPreconditions as evaluateSharedRemoteMutationPreconditions,
    type RemoteMutationGuardResult,
} from '../shared/remoteMutationPreconditions';

type SaplingRemoteMutationKind = 'push' | 'pull';

export function evaluateSaplingRemoteMutationPreconditions(input: {
    kind: SaplingRemoteMutationKind;
    snapshot: ScmWorkingSnapshot;
    hasExplicitBranch: boolean;
}): RemoteMutationGuardResult {
    return evaluateSharedRemoteMutationPreconditions({
        kind: input.kind,
        snapshot: input.snapshot,
        hasExplicitTarget: input.hasExplicitBranch,
        policy: {
            requireUpstreamWhenNoExplicitTarget: true,
            requireActiveHead: true,
            blockPushOnConflicts: true,
            blockPushWhenBehind: false,
            requireCleanPull: true,
        },
        mapReasonToError: mapSaplingRemoteMutationReason,
    });
}

function mapSaplingRemoteMutationReason(
    kind: ScmRemoteMutationKind,
    reason: ScmRemoteMutationReason
): Exclude<RemoteMutationGuardResult, { ok: true }> {
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
                error: kind === 'push'
                    ? 'Set a destination bookmark before push.'
                    : 'Set a destination bookmark before pull.',
            };
        case 'detached_head':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: kind === 'push'
                    ? 'Push is unavailable without an active checkout'
                    : 'Pull is unavailable without an active checkout',
            };
        case 'clean_worktree_required':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                error: 'Working tree must be clean before pull',
            };
        case 'branch_behind_remote':
        default:
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Remote operation preconditions failed',
            };
    }
}

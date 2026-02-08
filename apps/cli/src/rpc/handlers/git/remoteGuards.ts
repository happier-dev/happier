import type { GitWorkingSnapshot } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { hasAnyWorktreeChanges } from './runtime';

type RemoteMutationKind = 'push' | 'pull';

type RemoteMutationGuardResult =
    | { ok: true }
    | {
          ok: false;
          errorCode: keyof typeof GIT_OPERATION_ERROR_CODES;
          error: string;
      };

export function evaluateRemoteMutationPreconditions(input: {
    kind: RemoteMutationKind;
    snapshot: GitWorkingSnapshot;
    hasExplicitRemoteOrBranch: boolean;
}): RemoteMutationGuardResult {
    const { kind, snapshot, hasExplicitRemoteOrBranch } = input;

    if (kind === 'push' && snapshot.hasConflicts) {
        return {
            ok: false,
            errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Resolve conflicts before pushing.',
        };
    }

    if (!hasExplicitRemoteOrBranch && !snapshot.branch.upstream) {
        return {
            ok: false,
            errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
            error: kind === 'push' ? 'Set an upstream branch before push.' : 'Set an upstream branch before pull.',
        };
    }

    if (snapshot.branch.detached) {
        return {
            ok: false,
            errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: kind === 'push' ? 'Push is unavailable while HEAD is detached' : 'Pull is unavailable while HEAD is detached',
        };
    }

    if (kind === 'push' && snapshot.branch.behind > 0) {
        return {
            ok: false,
            errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
            error: 'Local branch is behind upstream. Pull before pushing.',
        };
    }

    if (kind === 'pull' && (snapshot.hasConflicts || hasAnyWorktreeChanges(snapshot))) {
        return {
            ok: false,
            errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Working tree must be clean before pull',
        };
    }

    return { ok: true };
}

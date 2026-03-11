import type { ScmRemotePublishRequest, ScmRemotePublishResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import { evaluateRemoteMutationPreconditions } from '../../shared/remoteMutationPreconditions';

import { readGitSnapshotForChecks } from './snapshotChecks';

export async function gitRemotePublish(input: {
    context: ScmBackendContext;
    request: ScmRemotePublishRequest;
}): Promise<ScmRemotePublishResponse> {
    const snapshotResponse = await readGitSnapshotForChecks(input.context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
        };
    }

    const snapshot = snapshotResponse.snapshot;
    const head = snapshot.branch.head;
    if (!head || snapshot.branch.detached) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Publish is unavailable while HEAD is detached',
        };
    }

    const guard = evaluateRemoteMutationPreconditions({
        kind: 'push',
        snapshot,
        hasExplicitTarget: true,
        policy: {
            requireUpstreamWhenNoExplicitTarget: false,
            requireActiveHead: true,
            blockPushOnConflicts: true,
            blockPushWhenBehind: true,
            requireCleanPull: false,
        },
        mapReasonToError: (kind, reason) => {
            switch (reason) {
                case 'conflicts_present':
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                        error: 'Resolve conflicts before publishing.',
                    };
                case 'detached_head':
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                        error: 'Publish is unavailable while HEAD is detached',
                    };
                case 'branch_behind_remote':
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                        error: 'Local branch is behind upstream. Pull before publishing.',
                    };
                case 'clean_worktree_required':
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                        error: 'Working tree must be clean before publishing',
                    };
                case 'upstream_required':
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                        error: kind === 'push' ? 'Set an upstream branch before publishing.' : 'Set an upstream branch before publishing.',
                    };
                default:
                    return {
                        ok: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: 'Publish preconditions failed',
                    };
            }
        },
    });

    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
        };
    }

    const remote = input.request.remote?.trim() || 'origin';
    const args = ['push', '--set-upstream', remote, head];
    const push = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    return push.success
        ? { success: true, stdout: push.stdout, stderr: push.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(push.stderr),
            error: push.stderr || 'Publish failed',
            stdout: push.stdout,
            stderr: push.stderr,
        };
}


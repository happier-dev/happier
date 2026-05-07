import type { ScmRemotePublishRequest, ScmRemotePublishResponse, ScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode, normalizeScmRemoteRequest } from '../remote';
import { evaluateRemoteMutationPreconditions } from '../../shared/remoteMutationPreconditions';

import { readGitSnapshotForChecks } from './snapshotChecks';

function resolveConfiguredPublishRemote(input: {
    snapshot: ScmWorkingSnapshot;
    requestedRemote: string | undefined;
}): { ok: true; remote: string } | { ok: false; error: string } {
    const remotes = input.snapshot.repo.remotes ?? [];
    if (remotes.length === 0) {
        return { ok: false, error: 'Add a Git remote before publishing this branch.' };
    }

    if (input.requestedRemote) {
        const requested = remotes.find((remote) => remote.name === input.requestedRemote);
        if (!requested) {
            return { ok: false, error: `Remote "${input.requestedRemote}" is not configured for this repository.` };
        }
        return { ok: true, remote: requested.name };
    }

    const origin = remotes.find((remote) => remote.name === 'origin');
    const fallback = remotes[0];
    if (!fallback) {
        return { ok: false, error: 'Add a Git remote before publishing this branch.' };
    }
    return { ok: true, remote: (origin ?? fallback).name };
}

export async function gitRemotePublish(input: {
    context: ScmBackendContext;
    request: ScmRemotePublishRequest;
}): Promise<ScmRemotePublishResponse> {
    const normalizedRemoteRequest = normalizeScmRemoteRequest({ remote: input.request.remote });
    if (!normalizedRemoteRequest.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalizedRemoteRequest.error,
        };
    }

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

    const remote = resolveConfiguredPublishRemote({
        snapshot,
        requestedRemote: normalizedRemoteRequest.request.remote,
    });
    if (!remote.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
            error: remote.error,
        };
    }

    const args = ['push', '--set-upstream', remote.remote, head];
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

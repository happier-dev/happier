import type {
  ScmRemotePublishRequest,
  ScmRemotePublishResponse,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
    normalizeScmOperationOutcome,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { runGitPushWithConnectedAccount } from './connectedAccountPush.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { normalizeScmRemoteRequest } from '../remote.js';
import { evaluateRemoteMutationPreconditions } from '../remoteGuards.js';
import { evaluateGitPushConfiguration, finalizeGitRemoteMutation } from './remoteOperations.js';

import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import { readGitSnapshotForChecks } from './snapshotChecks.js';

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

    return { ok: true, remote: (remotes.find((remote) => remote.name === 'origin') ?? remotes[0]).name };
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
            outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: normalizedRemoteRequest.error }),
        };
    }

    const snapshotResponse = await readGitSnapshotForChecks(input.context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
            outcome: normalizeScmOperationOutcome({ success: false, errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: snapshotResponse.error }),
        };
    }

    const snapshot = snapshotResponse.snapshot;
    const head = snapshot.branch.head;
    if (!head || snapshot.branch.detached) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Publish is unavailable while HEAD is detached',
            outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST }),
        };
    }

    const guard = evaluateRemoteMutationPreconditions({
        kind: 'push',
        snapshot,
        hasExplicitRemoteOrBranch: true,
    });

    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
            outcome: normalizeScmOperationOutcome({ success: false, errorCode: guard.errorCode, error: guard.error }),
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
            outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND, error: remote.error }),
        };
    }

    const configured = await evaluateGitPushConfiguration({ context: input.context, remote: remote.remote, hasExplicitRefspec: true });
    if (configured) return configured;

    const args = ['push', '--set-upstream', remote.remote, head];
    const push = await runGitPushWithConnectedAccount({ remote: remote.remote, command: {
        bin: 'git',
        cwd: input.context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
        signal: input.context.signal,
    } });

    const response = await finalizeGitRemoteMutation({ context: input.context, kind: 'push', command: push, target: { remote: remote.remote, branch: head }, effect: { kind: 'remote', remote: remote.remote, branch: head } });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({
        response,
        context: input.context,
        headBranch: head,
    });
    return response;
}

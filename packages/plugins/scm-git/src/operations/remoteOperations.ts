import type {
  ScmRemoteRequest,
  ScmRemoteResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import type { ScmBackendContext } from '../types.js';
import { runScmCommand } from '../runtime.js';
import { buildGitPullArgs, buildGitPushArgs, mapGitErrorCode, normalizeScmRemoteRequest } from '../remote.js';
import { evaluateRemoteMutationPreconditions } from '../remoteGuards.js';

import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import { readGitSnapshotForChecks } from './snapshotChecks.js';

export async function gitRemoteFetch(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalizedRemoteRequest = normalizeScmRemoteRequest(request);
    if (!normalizedRemoteRequest.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalizedRemoteRequest.error,
        };
    }

    const args = ['fetch', '--prune'];
    if (normalizedRemoteRequest.request.remote) args.push(normalizedRemoteRequest.request.remote);
    const fetch = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    const response: ScmRemoteResponse = fetch.success
        ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(fetch.stderr),
            error: fetch.stderr || 'Fetch failed',
            stderr: fetch.stderr,
        };
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context });
    return response;
}

export async function gitRemotePull(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalizedRemoteRequest = normalizeScmRemoteRequest(request);
    if (!normalizedRemoteRequest.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalizedRemoteRequest.error,
        };
    }

    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
        };
    }

    const guard = evaluateRemoteMutationPreconditions({
        kind: 'pull',
        snapshot: snapshotResponse.snapshot,
        hasExplicitRemoteOrBranch: Boolean(normalizedRemoteRequest.request.remote || normalizedRemoteRequest.request.branch),
    });
    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
        };
    }

    const args = buildGitPullArgs(normalizedRemoteRequest.request);
    const pull = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    const response: ScmRemoteResponse = pull.success
        ? { success: true, stdout: pull.stdout, stderr: pull.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(pull.stderr),
            error: pull.stderr || 'Pull failed',
            stderr: pull.stderr,
        };
    invalidatePrStatusCacheAfterSuccessfulScmMutation({
        response,
        context,
        headBranch: snapshotResponse.snapshot.branch.head,
    });
    return response;
}

export async function gitRemotePush(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalizedRemoteRequest = normalizeScmRemoteRequest(request);
    if (!normalizedRemoteRequest.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalizedRemoteRequest.error,
        };
    }

    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
        };
    }

    const guard = evaluateRemoteMutationPreconditions({
        kind: 'push',
        snapshot: snapshotResponse.snapshot,
        hasExplicitRemoteOrBranch: Boolean(normalizedRemoteRequest.request.remote || normalizedRemoteRequest.request.branch),
    });
    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
        };
    }

    const args = buildGitPushArgs(normalizedRemoteRequest.request);
    const push = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    const response: ScmRemoteResponse = push.success
        ? { success: true, stdout: push.stdout, stderr: push.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(push.stderr),
            error: push.stderr || 'Push failed',
            stderr: push.stderr,
        };
    invalidatePrStatusCacheAfterSuccessfulScmMutation({
        response,
        context,
        headBranch: snapshotResponse.snapshot.branch.head,
    });
    return response;
}

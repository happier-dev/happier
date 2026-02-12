import type {
    ScmRemoteTarget,
    ScmRemoteRequest,
    ScmRemoteResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { parseScmUpstreamRef } from '@happier-dev/protocol';
import { normalizeScmRemoteRequest } from '@happier-dev/protocol';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';

import { mapSaplingErrorCode } from '../errorCodes';
import { buildPullArgs, buildPushArgs } from '../remoteArgs';
import { getSaplingSnapshot } from '../repository';
import { evaluateSaplingRemoteMutationPreconditions } from '../remoteGuards';

function inferSaplingRemoteTargetFromSnapshot(snapshot: { branch: { upstream: string | null } }): ScmRemoteTarget {
    const parsed = parseScmUpstreamRef(snapshot.branch.upstream);
    return parsed ?? { remote: 'origin', branch: null };
}

function resolveTargetBranch(input: {
    request: { remote?: string; branch?: string };
    inferredTarget: ScmRemoteTarget;
}): string | undefined {
    const explicitBranch = input.request.branch?.trim();
    if (explicitBranch) return explicitBranch;

    const inferredBranch = input.inferredTarget.branch ?? undefined;
    if (!inferredBranch) return undefined;
    if (input.request.remote && input.request.remote !== input.inferredTarget.remote) {
        return undefined;
    }
    return inferredBranch;
}

export async function saplingRemoteFetch(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    const argsResult = buildPullArgs(normalized.request, false);
    if (!argsResult.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: argsResult.error,
        };
    }
    const fetch = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: argsResult.args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    return fetch.success
        ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
        : {
            success: false,
            errorCode: mapSaplingErrorCode(fetch.stderr),
            error: fetch.stderr || 'Fetch failed',
            stderr: fetch.stderr,
        };
}

export async function saplingRemotePull(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    const snapshot = await getSaplingSnapshot({
        cwd: context.cwd,
        projectKey: context.projectKey,
        detection: context.detection,
    });
    const inferredTarget = inferSaplingRemoteTargetFromSnapshot(snapshot);
    const inferredBranch = resolveTargetBranch({
        request: normalized.request,
        inferredTarget,
    });
    const requestWithTarget = {
        ...normalized.request,
        branch: inferredBranch,
    };
    const guard = evaluateSaplingRemoteMutationPreconditions({
        kind: 'pull',
        snapshot,
        hasExplicitBranch: Boolean(requestWithTarget.branch),
    });
    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
        };
    }
    const argsResult = buildPullArgs(requestWithTarget, true);
    if (!argsResult.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: argsResult.error,
        };
    }
    const pull = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: argsResult.args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    return pull.success
        ? { success: true, stdout: pull.stdout, stderr: pull.stderr }
        : {
            success: false,
            errorCode: mapSaplingErrorCode(pull.stderr),
            error: pull.stderr || 'Pull failed',
            stderr: pull.stderr,
        };
}

export async function saplingRemotePush(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { context, request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    const snapshot = await getSaplingSnapshot({
        cwd: context.cwd,
        projectKey: context.projectKey,
        detection: context.detection,
    });
    const inferredTarget = inferSaplingRemoteTargetFromSnapshot(snapshot);
    const inferredBranch = resolveTargetBranch({
        request: normalized.request,
        inferredTarget,
    });
    const requestWithTarget = {
        ...normalized.request,
        branch: inferredBranch,
    };
    const guard = evaluateSaplingRemoteMutationPreconditions({
        kind: 'push',
        snapshot,
        hasExplicitBranch: Boolean(requestWithTarget.branch),
    });
    if (!guard.ok) {
        return {
            success: false,
            errorCode: guard.errorCode,
            error: guard.error,
        };
    }
    const args = buildPushArgs(requestWithTarget);
    const push = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    return push.success
        ? { success: true, stdout: push.stdout, stderr: push.stderr }
        : {
            success: false,
            errorCode: mapSaplingErrorCode(push.stderr),
            error: push.stderr || 'Push failed',
            stderr: push.stderr,
        };
}

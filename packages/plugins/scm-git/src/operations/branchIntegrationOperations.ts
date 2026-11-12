import type {
  ScmBranchIntegrationOperation,
  ScmBranchIntegrationRequest,
  ScmBranchIntegrationResponse,
  ScmBranchOperationControlRequest,
  ScmConflictAcceptSideRequest,
  ScmConflictMarkResolvedRequest,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  SCM_OPERATION_ERROR_CODES,
  normalizeScmBranchSourceRef,
} from '@happier-dev/plugin-sdk/scm';

import { getScmCommandIndeterminateErrorCode, normalizeRepoRootPathspec, runScmCommand, type ScmExecResult } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { readGitBranchOperationState, readGitConflictEntries, readGitOperationRepositoryState } from './branchOperationState.js';
import { readGitSnapshotForChecks } from './snapshotChecks.js';

const GIT_BRANCH_INTEGRATION_TIMEOUT_MS = 60_000;

function hasPendingChanges(snapshot: ScmWorkingSnapshot): boolean {
    return (
        snapshot.totals.includedFiles > 0 ||
        snapshot.totals.pendingFiles > 0 ||
        snapshot.totals.untrackedFiles > 0
    );
}

async function readSnapshotForBranchIntegration(context: ScmBackendContext): Promise<
    | { ok: true; snapshot: ScmWorkingSnapshot }
    | { ok: false; response: ScmBranchIntegrationResponse }
> {
    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: snapshotResponse.error || 'Failed to evaluate repository state',
            },
        };
    }
    return { ok: true, snapshot: snapshotResponse.snapshot };
}

async function evaluateStartPreconditions(context: ScmBackendContext): Promise<ScmBranchIntegrationResponse | null> {
    const state = await readGitBranchOperationState(context);
    if (state) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS,
            error: 'A branch operation is already in progress',
            operationState: state,
        };
    }

    const snapshotResult = await readSnapshotForBranchIntegration(context);
    if (!snapshotResult.ok) {
        return snapshotResult.response;
    }

    const { snapshot } = snapshotResult;
    if (snapshot.branch.detached || !snapshot.branch.head) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Branch integration requires an active branch',
        };
    }

    if (snapshot.hasConflicts || hasPendingChanges(snapshot)) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Branch integration requires a clean worktree',
        };
    }

    return null;
}

async function settleBranchIntegration(input: {
    context: ScmBackendContext;
    result: ScmExecResult;
    fallback: string;
    allowRemainingConflicts?: boolean;
}): Promise<ScmBranchIntegrationResponse> {
    let repositoryState;
    try { repositoryState = await readGitOperationRepositoryState(input.context); }
    catch {
        if (input.result.success) return { success: true, errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, error: 'Operation applied, but repository refresh failed', stdout: input.result.stdout, stderr: input.result.stderr, outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, effect: { kind: 'branch', name: 'HEAD' }, nextActions: [{ kind: 'refresh' }] } };
        const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(input.result);
        const errorCode = indeterminateErrorCode ?? mapGitErrorCode(input.result.stderr);
        return { success: false, errorCode, error: input.result.stderr || input.fallback, stdout: input.result.stdout, stderr: input.result.stderr, outcome: indeterminateErrorCode
            ? { v: 1, kind: 'outcome_unknown', errorCode, reconciliation: { kind: 'repository_status', cwd: input.context.cwd }, nextActions: [{ kind: 'refresh' }] }
            : { v: 1, kind: 'failed', errorCode, nextActions: [{ kind: 'refresh' }] } };
    }
    const operationState = repositoryState.operation;
    const errorCode = repositoryState.hasConflicts ? SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE : mapGitErrorCode(input.result.stderr);
    if (repositoryState.hasConflicts && !(input.result.success && input.allowRemainingConflicts)) return { success: false, errorCode, error: input.result.stderr || input.fallback, stdout: input.result.stdout, stderr: input.result.stderr, operationState, outcome: { v: 1, kind: 'conflicted', errorCode, repositoryState, nextActions: [{ kind: 'resolve_conflicts' }, ...(operationState?.canSkip ? [{ kind: 'skip' as const }] : []), ...(operationState?.canAbort ? [{ kind: 'abort' as const }] : [])] } };
    const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(input.result);
    if (indeterminateErrorCode) return { success: false, errorCode: indeterminateErrorCode, error: input.result.stderr || input.fallback, stdout: input.result.stdout, stderr: input.result.stderr, operationState, outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminateErrorCode, repositoryState, reconciliation: { kind: 'repository_status', cwd: input.context.cwd }, nextActions: [{ kind: 'refresh' }] } };
    if (input.result.success) return { success: true, stdout: input.result.stdout, stderr: input.result.stderr, operationState, outcome: { v: 1, kind: 'succeeded', repositoryState, nextActions: [] } };
    return {
        success: false,
        errorCode,
        error: input.result.stderr || input.fallback,
        stdout: input.result.stdout,
        stderr: input.result.stderr,
        operationState,
        outcome: { v: 1, kind: 'failed', errorCode, repositoryState, nextActions: [] },
    };
}

async function runBranchIntegration(input: {
    context: ScmBackendContext;
    operation: ScmBranchIntegrationOperation;
    sourceRef: string;
}): Promise<ScmBranchIntegrationResponse> {
    const args = input.operation === 'merge'
        ? ['merge', '--no-edit', input.sourceRef]
        : ['rebase', input.sourceRef];

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args,
        timeoutMs: GIT_BRANCH_INTEGRATION_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv({ GIT_EDITOR: 'true' }),
    });
    return settleBranchIntegration({ context: input.context, result, fallback: `${input.operation} failed` });
}

async function startBranchIntegration(input: {
    context: ScmBackendContext;
    request: ScmBranchIntegrationRequest;
    operation: ScmBranchIntegrationOperation;
}): Promise<ScmBranchIntegrationResponse> {
    const normalized = normalizeScmBranchSourceRef(input.request.sourceRef);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }

    const preconditionFailure = await evaluateStartPreconditions(input.context);
    if (preconditionFailure) {
        return preconditionFailure;
    }

    return runBranchIntegration({
        context: input.context,
        operation: input.operation,
        sourceRef: normalized.sourceRef,
    });
}

async function controlBranchOperation(input: {
    context: ScmBackendContext;
    request: ScmBranchOperationControlRequest;
    action: 'continue' | 'abort' | 'skip';
}): Promise<ScmBranchIntegrationResponse> {
    const state = await readGitBranchOperationState(input.context);
    if (!state || state.kind !== input.request.operation) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS,
            error: `No ${input.request.operation} operation is in progress`,
            operationState: state,
        };
    }

    if ((input.action === 'continue' && !state.canContinue) || (input.action === 'skip' && !state.canSkip)) {
        const repositoryState = await readGitOperationRepositoryState(input.context);
        const errorCode = repositoryState.hasConflicts ? SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE : SCM_OPERATION_ERROR_CODES.INVALID_REQUEST;
        return { success: false, errorCode, error: `Operation cannot ${input.action} in its current state`, operationState: state, outcome: repositoryState.hasConflicts ? { v: 1, kind: 'conflicted', errorCode, repositoryState, nextActions: [{ kind: 'resolve_conflicts' }] } : { v: 1, kind: 'failed', errorCode, repositoryState, nextActions: [] } };
    }

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: [input.request.operation === 'cherry_pick' ? 'cherry-pick' : input.request.operation, `--${input.action}`],
        timeoutMs: GIT_BRANCH_INTEGRATION_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv({ GIT_EDITOR: 'true' }),
    });
    return settleBranchIntegration({ context: input.context, result, fallback: `${input.request.operation} ${input.action} failed` });
}

export async function gitBranchMerge(input: {
    context: ScmBackendContext;
    request: ScmBranchIntegrationRequest;
}): Promise<ScmBranchIntegrationResponse> {
    return startBranchIntegration({
        ...input,
        operation: 'merge',
    });
}

export async function gitBranchRebase(input: {
    context: ScmBackendContext;
    request: ScmBranchIntegrationRequest;
}): Promise<ScmBranchIntegrationResponse> {
    return startBranchIntegration({
        ...input,
        operation: 'rebase',
    });
}

export async function gitBranchOperationContinue(input: {
    context: ScmBackendContext;
    request: ScmBranchOperationControlRequest;
}): Promise<ScmBranchIntegrationResponse> {
    return controlBranchOperation({
        ...input,
        action: 'continue',
    });
}

export async function gitBranchOperationAbort(input: {
    context: ScmBackendContext;
    request: ScmBranchOperationControlRequest;
}): Promise<ScmBranchIntegrationResponse> {
    return controlBranchOperation({
        ...input,
        action: 'abort',
    });
}

export async function gitBranchOperationSkip(input: { context: ScmBackendContext; request: ScmBranchOperationControlRequest }): Promise<ScmBranchIntegrationResponse> {
    return controlBranchOperation({ ...input, action: 'skip' });
}

export async function gitConflictMarkResolved(input: { context: ScmBackendContext; request: ScmConflictMarkResolvedRequest }): Promise<ScmBranchIntegrationResponse> {
    const paths = input.request.paths.map(normalizeRepoRootPathspec);
    const invalid = paths.find((path) => !path.ok);
    if (invalid && !invalid.ok) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: invalid.error };
    if (paths.length === 0) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Select at least one conflict path' };
    const conflicts = await readGitConflictEntries(input.context);
    if (input.request.paths.some((path) => !conflicts.some((entry) => entry.path === path))) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Selected path is no longer unmerged' };
    const result = await runScmCommand({ bin: 'git', cwd: input.context.cwd, args: ['add', '-A', '--', ...paths.flatMap((path) => path.ok ? [path.pathspec] : [])], timeoutMs: GIT_BRANCH_INTEGRATION_TIMEOUT_MS, env: buildScmNonInteractiveEnv() });
    return settleBranchIntegration({ context: input.context, result, fallback: 'Failed to stage resolved conflicts', allowRemainingConflicts: true });
}

export async function gitConflictAcceptSide(input: { context: ScmBackendContext; request: ScmConflictAcceptSideRequest }): Promise<ScmBranchIntegrationResponse> {
    const path = normalizeRepoRootPathspec(input.request.path);
    if (!path.ok) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: path.error };
    if (input.request.side !== 'ours' && input.request.side !== 'theirs') return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid conflict side' };
    const conflict = (await readGitConflictEntries(input.context)).find((entry) => entry.path === input.request.path);
    if (!conflict) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Selected path is no longer unmerged' };
    const selectedStage = conflict.indexStages?.[input.request.side];
    const result = await runScmCommand({ bin: 'git', cwd: input.context.cwd, args: selectedStage ? ['checkout', `--${input.request.side}`, '--', path.pathspec] : ['rm', '--', path.pathspec], timeoutMs: GIT_BRANCH_INTEGRATION_TIMEOUT_MS, env: buildScmNonInteractiveEnv() });
    if (!result.success || !selectedStage) return settleBranchIntegration({ context: input.context, result, fallback: 'Failed to accept conflict side', allowRemainingConflicts: true });
    return gitConflictMarkResolved({ context: input.context, request: { paths: [input.request.path] } });
}

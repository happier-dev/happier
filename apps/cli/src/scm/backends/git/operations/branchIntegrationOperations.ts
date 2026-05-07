import type {
    ScmBranchIntegrationOperation,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchOperationControlRequest,
    ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import {
    SCM_OPERATION_ERROR_CODES,
    normalizeScmBranchSourceRef,
} from '@happier-dev/protocol';

import { runScmCommand } from '../../../runtime';
import type { ScmBackendContext } from '../../../types';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import { readGitSnapshotForChecks } from './snapshotChecks';
import { readGitBranchOperationState } from './branchOperationState';

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

function mapBranchIntegrationFailure(input: {
    stderr: string;
    fallback: string;
    operationState: Awaited<ReturnType<typeof readGitBranchOperationState>>;
}): ScmBranchIntegrationResponse {
    if (input.operationState || /conflict|fix conflicts|merge failed|could not apply/i.test(input.stderr)) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: input.stderr || input.fallback,
            stderr: input.stderr,
            operationState: input.operationState,
        };
    }
    return {
        success: false,
        errorCode: mapGitErrorCode(input.stderr),
        error: input.stderr || input.fallback,
        stderr: input.stderr,
        operationState: input.operationState,
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
    const operationState = await readGitBranchOperationState(input.context);
    return result.success
        ? {
            success: true,
            stdout: result.stdout,
            stderr: result.stderr,
            operationState,
        }
        : mapBranchIntegrationFailure({
            stderr: result.stderr,
            fallback: `${input.operation} failed`,
            operationState,
        });
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
    action: 'continue' | 'abort';
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

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: [input.request.operation, `--${input.action}`],
        timeoutMs: GIT_BRANCH_INTEGRATION_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv({ GIT_EDITOR: 'true' }),
    });
    const operationState = await readGitBranchOperationState(input.context);
    return result.success
        ? {
            success: true,
            stdout: result.stdout,
            stderr: result.stderr,
            operationState,
        }
        : mapBranchIntegrationFailure({
            stderr: result.stderr,
            fallback: `${input.request.operation} ${input.action} failed`,
            operationState,
        });
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

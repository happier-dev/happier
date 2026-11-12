import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryInitRequest,
  type ScmRepositoryInitResponse,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';

import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext, ScmRepoDetection } from '../types.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { detectGitRepo, getGitSnapshot } from '../repository.js';

const GIT_REPOSITORY_INIT_TIMEOUT_MS = 30_000;
const GIT_REPOSITORY_INIT_CHECK_TIMEOUT_MS = 10_000;

type SnapshotResult =
    | { ok: true; snapshot: ScmWorkingSnapshot }
    | { ok: false; response: Extract<ScmRepositoryInitResponse, { success: false }> };

function contextWithDetection(
    context: ScmBackendContext,
    detection: ScmRepoDetection,
): ScmBackendContext {
    return {
        ...context,
        detection,
    };
}

async function readInitializedGitSnapshot(context: ScmBackendContext): Promise<SnapshotResult> {
    const snapshotResponse = await getGitSnapshot({ context });
    if (snapshotResponse.success && snapshotResponse.snapshot) {
        return {
            ok: true,
            snapshot: snapshotResponse.snapshot,
        };
    }

    return {
        ok: false,
        response: {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to read initialized Git repository snapshot.',
        },
    };
}

function invalidInitialBranchResponse(error: string, stdout?: string, stderr?: string): ScmRepositoryInitResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        error,
        stdout,
        stderr,
    };
}

async function validateInitialBranch(
    cwd: string,
    initialBranch: string | undefined,
): Promise<ScmRepositoryInitResponse | null> {
    if (initialBranch === undefined) return null;
    if (initialBranch.trim().length === 0 || initialBranch.includes('\0')) {
        return invalidInitialBranchResponse('Initial branch name is invalid.');
    }

    const checkBranch = await runScmCommand({
        bin: 'git',
        cwd,
        args: ['check-ref-format', '--branch', initialBranch],
        timeoutMs: GIT_REPOSITORY_INIT_CHECK_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });

    return checkBranch.success
        ? null
        : invalidInitialBranchResponse(
            checkBranch.stderr || 'Initial branch name is invalid.',
            checkBranch.stdout,
            checkBranch.stderr,
        );
}

export async function gitRepositoryInit(input: {
    context: ScmBackendContext;
    request: ScmRepositoryInitRequest;
}): Promise<ScmRepositoryInitResponse> {
    const existingDetection = await detectGitRepo({ cwd: input.context.cwd });
    if (existingDetection.isRepo) {
        const snapshot = await readInitializedGitSnapshot(contextWithDetection(input.context, existingDetection));
        if (!snapshot.ok) return snapshot.response;
        return {
            success: true,
            alreadyInitialized: true,
            snapshot: snapshot.snapshot,
        };
    }

    const branchValidation = await validateInitialBranch(input.context.cwd, input.request.initialBranch);
    if (branchValidation) return branchValidation;

    const init = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['init'],
        timeoutMs: GIT_REPOSITORY_INIT_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });
    if (!init.success) {
        return {
            success: false,
            errorCode: mapGitErrorCode(init.stderr),
            error: init.stderr || 'Failed to initialize Git repository.',
            stdout: init.stdout,
            stderr: init.stderr,
        };
    }

    if (input.request.initialBranch) {
        const setHead = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['symbolic-ref', 'HEAD', `refs/heads/${input.request.initialBranch}`],
            timeoutMs: GIT_REPOSITORY_INIT_CHECK_TIMEOUT_MS,
            env: buildScmNonInteractiveEnv(),
        });
        if (!setHead.success) {
            return {
                success: false,
                errorCode: mapGitErrorCode(setHead.stderr),
                error: setHead.stderr || 'Failed to set initial Git branch.',
                stdout: setHead.stdout,
                stderr: setHead.stderr,
            };
        }
    }

    const refreshWarning = (error: string): ScmRepositoryInitResponse => ({
        success: true, alreadyInitialized: false,
        stdout: init.stdout, stderr: init.stderr,
        errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, error,
        outcome: { v: 1, kind: 'succeeded', message: error, nextActions: [{ kind: 'refresh' }] },
    });
    try {
        const initializedDetection = await detectGitRepo({ cwd: input.context.cwd });
        if (!initializedDetection.isRepo) return refreshWarning('Git repository initialized, but the repository could not be detected.');
        const snapshot = await readInitializedGitSnapshot(contextWithDetection(input.context, initializedDetection));
        if (!snapshot.ok) return refreshWarning(snapshot.response.error || 'Git repository initialized, but its snapshot could not be refreshed.');
        return {
            success: true,
            alreadyInitialized: false,
            snapshot: snapshot.snapshot,
            stdout: init.stdout,
            stderr: init.stderr,
        };
    } catch (error) {
        return refreshWarning(error instanceof Error ? error.message : 'Git repository initialized, but its state could not be refreshed.');
    }
}

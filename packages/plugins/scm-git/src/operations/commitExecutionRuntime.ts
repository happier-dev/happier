import {
    createGitTemporaryIndex as createSharedGitTemporaryIndex,
    type GitTemporaryIndex as SharedGitTemporaryIndex,
    type GitTemporaryIndexSeed,
} from '@happier-dev/cli-common/scm/gitTemporaryIndex';

import type { ScmCommitCreateResponse } from '@happier-dev/plugin-sdk/scm';
import type { BackendCommandRunInput } from '@happier-dev/plugin-sdk/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runScmCommand } from '../runtime.js';
import { applyValidatedGitPatch } from './applyValidatedGitPatch.js';

export type GitCommandOptions = {
    cwd: string;
    args: string[];
    timeoutMs?: number;
    stdin?: string;
    stdinInteraction?: BackendCommandRunInput['stdinInteraction'];
    env?: Record<string, string | undefined>;
};

export type GitTemporaryIndex = SharedGitTemporaryIndex;

export async function runGitCommand(input: GitCommandOptions) {
    return runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.args,
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        stdinInteraction: input.stdinInteraction,
        env: input.env,
    });
}

export async function createGitTemporaryIndex(input: {
    cwd: string;
    seed: GitTemporaryIndexSeed;
}): Promise<
    | { success: true; tempIndex: GitTemporaryIndex }
    | { success: false; errorCode: 'COMMAND_FAILED'; error: string }
> {
    const result = await createSharedGitTemporaryIndex({
        cwd: input.cwd,
        seed: input.seed,
        runGit: (command) => runGitCommand({ ...command, args: [...command.args], timeoutMs: 5000 }),
    });
    return result.success ? result : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: result.error };
}

export async function applyPatchToIndex(input: {
    cwd: string;
    patch: string;
    env?: Record<string, string | undefined>;
}): Promise<ScmCommitCreateResponse | null> {
    const patchResult = await applyValidatedGitPatch({
        cwd: input.cwd,
        patch: input.patch,
        target: 'index',
        env: input.env,
    });
    if (!patchResult.success) {
        return {
            success: false,
            errorCode: patchResult.errorCode ?? SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: patchResult.error || 'Patch apply failed',
        };
    }

    return null;
}

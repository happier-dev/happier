import type { ScmChangeApplyResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmCommand } from '../../../runtime';

type GitPatchTarget = 'index' | 'worktree';

function buildGitApplyArgs(input: {
    target: GitPatchTarget;
    reverse?: boolean;
    check?: boolean;
}): string[] {
    const args = ['apply'];
    if (input.check) {
        args.push('--check');
    }
    if (input.target === 'index') {
        args.push('--cached');
    }
    if (input.reverse) {
        args.push('--reverse');
    }
    args.push('--unidiff-zero', '--recount', '--whitespace=nowarn', '-');
    return args;
}

export async function applyValidatedGitPatch(input: {
    cwd: string;
    patch: string;
    target: GitPatchTarget;
    reverse?: boolean;
    env?: Record<string, string | undefined>;
    checkError?: string;
    applyError?: string;
}): Promise<ScmChangeApplyResponse> {
    const check = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: buildGitApplyArgs({
            target: input.target,
            reverse: input.reverse,
            check: true,
        }),
        stdin: input.patch,
        timeoutMs: 15_000,
        env: input.env,
    });
    if (!check.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: check.stderr || input.checkError || 'Patch check failed',
            stderr: check.stderr,
        };
    }

    const apply = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: buildGitApplyArgs({
            target: input.target,
            reverse: input.reverse,
        }),
        stdin: input.patch,
        timeoutMs: 15_000,
        env: input.env,
    });
    return apply.success
        ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: apply.stderr || input.applyError || 'Patch apply failed',
            stderr: apply.stderr,
        };
}

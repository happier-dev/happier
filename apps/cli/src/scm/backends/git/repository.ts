import type { ScmRepoDetection, ScmBackendContext } from '../../types';
import type { ScmStatusSnapshotResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmCommand } from '../../runtime';
import { buildGitSnapshot } from './statusSnapshot';

export async function detectGitRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const gitRepoCheck = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5000,
    });
    if (!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) {
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rootResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--show-toplevel'],
        timeoutMs: 5000,
    });

    return {
        isRepo: true,
        rootPath: rootResult.success ? rootResult.stdout.trim() : null,
        mode: '.git',
    };
}

export async function getGitSnapshot(input: {
    context: ScmBackendContext;
}): Promise<ScmStatusSnapshotResponse> {
    const { context } = input;

    const statusResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
        timeoutMs: 10_000,
    });
    if (!statusResult.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: statusResult.stderr || 'Failed to read repository status',
        };
    }

    const includedResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--cached', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const pendingResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--numstat', '-z'],
        timeoutMs: 10_000,
    });

    return {
        success: true,
        snapshot: buildGitSnapshot({
            projectKey: context.projectKey,
            fetchedAt: Date.now(),
            rootPath: context.detection.rootPath,
            statusOutput: statusResult.stdout ?? '',
            includedNumStatOutput: includedResult.success ? (includedResult.stdout ?? '') : '',
            pendingNumStatOutput: pendingResult.success ? (pendingResult.stdout ?? '') : '',
        }),
    };
}

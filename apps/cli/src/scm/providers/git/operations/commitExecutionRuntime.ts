import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { ScmCommitCreateResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmCommand } from '../../../runtime';
import { applyValidatedGitPatch } from './applyValidatedGitPatch';

export type GitCommandOptions = {
    cwd: string;
    args: string[];
    timeoutMs?: number;
    stdin?: string;
    env?: Record<string, string | undefined>;
};

export type GitTemporaryIndex = {
    indexPath: string;
    env: Record<string, string>;
    cleanup: () => void;
};

export async function runGitCommand(input: GitCommandOptions) {
    return runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.args,
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        env: input.env,
    });
}

async function resolveGitIndexPath(cwd: string): Promise<
    | { success: true; indexPath: string }
    | { success: false; error: string }
> {
    const result = await runGitCommand({
        cwd,
        args: ['rev-parse', '--git-path', 'index'],
        timeoutMs: 5000,
    });
    if (!result.success) {
        return {
            success: false,
            error: result.stderr || 'Failed to resolve repository index path',
        };
    }

    const rawPath = result.stdout.trim();
    if (!rawPath) {
        return {
            success: false,
            error: 'Failed to resolve repository index path',
        };
    }
    return {
        success: true,
        indexPath: isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath),
    };
}

export async function createGitTemporaryIndex(input: {
    cwd: string;
    seed: 'head-or-empty' | 'current-index';
}): Promise<
    | { success: true; tempIndex: GitTemporaryIndex }
    | { success: false; errorCode: 'COMMAND_FAILED'; error: string }
> {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-scm-index-'));
    const indexPath = join(tempDir, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    const cleanup = () => {
        rmSync(tempDir, { recursive: true, force: true });
    };

    if (input.seed === 'current-index') {
        const sourceIndex = await resolveGitIndexPath(input.cwd);
        if (!sourceIndex.success) {
            cleanup();
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: sourceIndex.error,
            };
        }
        if (existsSync(sourceIndex.indexPath)) {
            copyFileSync(sourceIndex.indexPath, indexPath);
        } else {
            writeFileSync(indexPath, '');
        }
        return {
            success: true,
            tempIndex: {
                indexPath,
                env,
                cleanup,
            },
        };
    }

    writeFileSync(indexPath, '');
    const readHead = await runGitCommand({
        cwd: input.cwd,
        args: ['read-tree', 'HEAD'],
        timeoutMs: 5000,
        env,
    });
    if (!readHead.success) {
        const readEmpty = await runGitCommand({
            cwd: input.cwd,
            args: ['read-tree', '--empty'],
            timeoutMs: 5000,
            env,
        });
        if (!readEmpty.success) {
            cleanup();
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: readHead.stderr || readEmpty.stderr || 'Failed to initialize temporary commit index',
            };
        }
    }

    return {
        success: true,
        tempIndex: {
            indexPath,
            env,
            cleanup,
        },
    };
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

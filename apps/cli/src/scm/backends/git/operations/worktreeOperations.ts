import type {
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { mkdir } from 'node:fs/promises';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';

function normalizeWorktreeNameSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return '';

    return trimmed
        .replace(/\s+/g, '-')
        .replace(/@\{/g, '-')
        .replace(/[~^:?*[\]\\]/g, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/(^[./-]+)|([./-]+$)/g, '')
        .replace(/-+/g, '-');
}

function hasForbiddenGitRefSegment(segment: string): boolean {
    const normalizedSegment = normalizeWorktreeNameSegment(segment);
    return normalizedSegment === '@' || normalizedSegment.endsWith('.lock');
}

function normalizeWorktreeDisplayName(value: string): string {
    const normalizedSegments = value
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .map(normalizeWorktreeNameSegment)
        .filter((segment) => segment.length > 0);

    return normalizedSegments.join('/');
}

function hasForbiddenGitRefName(value: string): boolean {
    return value
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .some(hasForbiddenGitRefSegment);
}

function normalizeBaseRef(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('-')) return null;
    return trimmed;
}

function normalizeBranchMode(value: string | null | undefined): 'new' | 'existing' {
    return value === 'existing' ? 'existing' : 'new';
}

function trimCommandOutput(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function resolveParentPath(path: string): string | null {
    const normalizedPath = trimCommandOutput(path).replace(/\\/g, '/').replace(/\/+$/g, '');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    if (lastSlashIndex <= 0) {
        return null;
    }

    return normalizedPath.slice(0, lastSlashIndex);
}

function resolveRepositoryRootPath(params: Readonly<{
    sourceRootPath: string;
    gitCommonDir: string | null | undefined;
}>): string {
    const normalizedCommonDir = trimCommandOutput(params.gitCommonDir).replace(/\\/g, '/').replace(/\/+$/g, '');
    if (normalizedCommonDir.endsWith('/.git')) {
        return resolveParentPath(normalizedCommonDir) ?? params.sourceRootPath;
    }

    return params.sourceRootPath;
}

async function resolveCreateWorktreePaths(context: ScmBackendContext): Promise<{
    sourceRootPath: string;
    repositoryRootPath: string;
}> {
    const sourceRootResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--show-toplevel'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });
    const sourceRootPath = sourceRootResult.success
        ? trimCommandOutput(sourceRootResult.stdout) || context.cwd
        : context.cwd;

    const gitCommonDirResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    return {
        sourceRootPath,
        repositoryRootPath: gitCommonDirResult.success
            ? resolveRepositoryRootPath({
                sourceRootPath,
                gitCommonDir: gitCommonDirResult.stdout,
            })
            : sourceRootPath,
    };
}

async function resolveImplicitBaseRef(context: ScmBackendContext): Promise<string | null> {
    const headResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--verify', 'HEAD'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });

    return headResult.success ? normalizeBaseRef(headResult.stdout) : null;
}

function buildGitWorktreeAddArgs(params: Readonly<{
    branchName: string;
    worktreePath: string;
    branchMode: 'new' | 'existing';
    baseRef?: string | null;
}>): string[] {
    if (params.branchMode === 'existing') {
        return ['worktree', 'add', '--', params.worktreePath, params.branchName];
    }

    const args = ['worktree', 'add', '-b', params.branchName, '--', params.worktreePath];

    const baseRef = normalizeBaseRef(params.baseRef);
    if (baseRef) {
        args.push(baseRef);
    }

    return args;
}

function validateWorktreePath(value: string): { ok: true; value: string } | { ok: false; error: string } {
    const normalized = value.trim();
    if (!normalized) {
        return { ok: false, error: 'Worktree path cannot be empty' };
    }
    return { ok: true, value: normalized };
}

export async function gitWorktreeCreate(input: {
    context: ScmBackendContext;
    request: ScmWorktreeCreateRequest;
}): Promise<ScmWorktreeCreateResponse> {
    const explicitDisplayName = String(input.request.displayName ?? '');
    if (explicitDisplayName.trim() && hasForbiddenGitRefName(explicitDisplayName)) {
        return {
            success: false,
            worktreePath: '',
            branchName: '',
            error: 'Invalid Git worktree name',
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        };
    }

    const displayName = normalizeWorktreeDisplayName(explicitDisplayName) || 'worktree';
    const branchMode = normalizeBranchMode(input.request.branchMode);
    const explicitBaseRef = normalizeBaseRef(input.request.baseRef);
    if (input.request.baseRef != null && String(input.request.baseRef).trim() && explicitBaseRef == null) {
        return {
            success: false,
            worktreePath: '',
            branchName: '',
            error: 'Invalid Git base ref',
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        };
    }

    const gitCheck = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['rev-parse', '--git-dir'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!gitCheck.success) {
        return {
            success: false,
            worktreePath: '',
            branchName: '',
            error: 'Not a Git repository',
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
        };
    }

    const resolvedPaths = await resolveCreateWorktreePaths(input.context);
    const resolvedBaseRef = branchMode === 'existing'
        ? null
        : explicitBaseRef ?? await resolveImplicitBaseRef(input.context);

    await mkdir(`${resolvedPaths.repositoryRootPath}/.dev/worktree`, { recursive: true });

    const tryCreate = async (branchName: string): Promise<ScmWorktreeCreateResponse> => {
        const relativeWorktreePath = `.dev/worktree/${branchName}`;
        const result = await runScmCommand({
            bin: 'git',
            cwd: resolvedPaths.repositoryRootPath,
            args: buildGitWorktreeAddArgs({
                branchName,
                worktreePath: relativeWorktreePath,
                branchMode,
                baseRef: resolvedBaseRef,
            }),
            timeoutMs: 60_000,
            env: buildScmNonInteractiveEnv(),
        });

        if (!result.success) {
            return {
                success: false,
                worktreePath: '',
                branchName: '',
                error: result.stderr || 'Failed to create worktree',
                errorCode: mapGitErrorCode(result.stderr),
            };
        }

        return {
            success: true,
            worktreePath: `${resolvedPaths.repositoryRootPath}/${relativeWorktreePath}`,
            branchName,
            sourceRootPath: resolvedPaths.sourceRootPath,
            repositoryRootPath: resolvedPaths.repositoryRootPath,
        };
    };

    const initialAttempt = await tryCreate(displayName);
    if (initialAttempt.success || !(initialAttempt.error ?? '').includes('already exists')) {
        return initialAttempt;
    }

    for (let index = 2; index <= 4; index += 1) {
        const retry = await tryCreate(`${displayName}-${index}`);
        if (retry.success) {
            return retry;
        }
        if (!(retry.error ?? '').includes('already exists')) {
            return retry;
        }
    }

    return initialAttempt;
}

export async function gitWorktreeRemove(input: {
    context: ScmBackendContext;
    request: ScmWorktreeRemoveRequest;
}): Promise<ScmWorktreeRemoveResponse> {
    const validatedPath = validateWorktreePath(input.request.worktreePath);
    if (!validatedPath.ok) {
        return {
            success: false,
            error: validatedPath.error,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        };
    }

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['worktree', 'remove', '--force', '--', validatedPath.value],
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!result.success) {
        return {
            success: false,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.stderr || 'Failed to remove worktree',
            errorCode: mapGitErrorCode(result.stderr),
        };
    }

    return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

export async function gitWorktreePrune(input: {
    context: ScmBackendContext;
    request: ScmWorktreePruneRequest;
}): Promise<ScmWorktreePruneResponse> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['worktree', 'prune'],
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!result.success) {
        return {
            success: false,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.stderr || 'Failed to prune worktrees',
            errorCode: mapGitErrorCode(result.stderr),
        };
    }

    return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

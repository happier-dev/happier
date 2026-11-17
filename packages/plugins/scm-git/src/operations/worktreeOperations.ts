import type {
  ScmWorktreeCreateRequest,
  ScmWorktreeCreateResponse,
  ScmWorktreePruneRequest,
  ScmWorktreePruneResponse,
  ScmWorktreeRemoveRequest,
  ScmWorktreeRemoveResponse,
} from '@happier-dev/plugin-sdk/scm';
import {
  SCM_OPERATION_ERROR_CODES,
  SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
  hasForbiddenGitRefName,
  normalizeWorktreeDisplayName,
} from '@happier-dev/plugin-sdk/scm';
import type { ScmBackendContext } from '../types.js';
import { runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { createGitWorkspaceCheckoutAtDefaultPath } from './materializeGitWorkspaceCheckout.js';
import { lstat, rm, readFile } from 'node:fs/promises';
import { basename, dirname, join, toNamespacedPath } from 'node:path';
import { canonicalAbsolutePathsEqual, canonicalizePath, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { inspectGitCheckoutIdentity, resolveGitMainWorktreePath } from '../checkoutIdentity.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';
import { withGitWorktreeMutation } from './worktreeMutationQueue.js';
import { readGitRetentionKind } from './worktreeRetentionFacts.js';
import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

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

    const worktreesResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['worktree', 'list', '--porcelain', '-z'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    return {
        sourceRootPath,
        repositoryRootPath: worktreesResult.success
            ? await resolveGitMainWorktreePath({ worktreesOutput: worktreesResult.stdout,
                currentWorktreePath: sourceRootPath }) ?? sourceRootPath
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
            error: 'Not a Git repository',
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
        };
    }

    const resolvedPaths = await resolveCreateWorktreePaths(input.context);
    const resolvedBaseRef = branchMode === 'existing'
        ? null
        : explicitBaseRef ?? await resolveImplicitBaseRef(input.context);
    try {
        const materialized = await createGitWorkspaceCheckoutAtDefaultPath({
            repoRoot: resolvedPaths.repositoryRootPath,
            displayName,
            baseRef: resolvedBaseRef,
            branchMode,
            assertFilesystemPathAuthorized: input.context.assertFilesystemPathAuthorized,
        });
        return {
            success: true,
            worktreePath: materialized.targetPath,
            branchName: materialized.branchName,
            sourceRootPath: resolvedPaths.sourceRootPath,
            repositoryRootPath: resolvedPaths.repositoryRootPath,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: message || 'Failed to create worktree',
            errorCode: error instanceof Error && 'errorCode' in error && error.errorCode === SCM_OPERATION_ERROR_CODES.INVALID_PATH
                ? SCM_OPERATION_ERROR_CODES.INVALID_PATH
                : mapGitErrorCode(message),
        };
    }
}

export async function gitWorktreeRemove(input: {
    context: ScmBackendContext;
    request: ScmWorktreeRemoveRequest;
}): Promise<ScmWorktreeRemoveResponse> {
    if (input.request.confirmed !== true || input.request.authorizationToken !== SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN) {
        return {
            success: false,
            error: 'Worktree removal requires explicit authorization.',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        };
    }

    const validatedPath = validateWorktreePath(input.request.worktreePath);
    if (!validatedPath.ok) {
        return {
            success: false,
            error: validatedPath.error,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        };
    }

    return withGitWorktreeMutation(input.context.cwd, async () => {
        const path = validatedPath.value;
        input.context.assertFilesystemPathAuthorized?.(path);
        const before = await readPathIdentity(path);
        let missingWorktree: Parameters<NonNullable<ScmBackendContext['beforeFilesystemMutation']>>[0];
        if (before?.isDirectory() && !before.isSymbolicLink() && input.context.beforeFilesystemMutation
            && await readGitRetentionKind(path, input.context.cwd, input.context.retainedSourcePath ?? path)) {
            const remove = readCurrentBackendRuntimeServices()?.removeRetainedPath;
            if (!remove) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The host does not support retained SCM deletion' };
            await remove({ path, expectedIdentity: { dev: String(before.dev), ino: String(before.ino) },
                beforeEffect: input.context.beforeFilesystemMutation });
            return { success: true };
        }
        if (!before && input.context.beforeFilesystemMutation) {
            const listed = await runScmCommand({ bin: 'git', cwd: input.context.cwd,
                args: ['worktree', 'list', '--porcelain', '-z'], env: buildScmNonInteractiveEnv() });
            if (!listed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: listed.stderr };
            const registered = parseGitWorktreeListPorcelain({ worktreesOutput: listed.stdout, currentWorktreePath: null });
            const retained = registered.find(entry => canonicalAbsolutePathsEqual(entry.path, path));
            if (retained) missingWorktree = { physicalRootPath: retained.path, alreadyAbsent: true };
            else {
                await input.context.beforeFilesystemMutation();
                if (await readPathIdentity(path)) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: 'The removed worktree path became occupied' };
                return { success: true };
            }
        }
        const identity = before ? await inspectGitCheckoutIdentity({ cwd: path }) : null;
        const physicalPath = identity ? await canonicalizePath(path) : path;
        if (identity) {
            const list = await runScmCommand({ bin: 'git', cwd: input.context.cwd,
                args: ['worktree', 'list', '--porcelain', '-z'], env: buildScmNonInteractiveEnv() });
            if (!list.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: list.stderr };
            const nested = parseGitWorktreeListPorcelain({ worktreesOutput: list.stdout, currentWorktreePath: null })
                .some(entry => !canonicalAbsolutePathsEqual(entry.path, physicalPath) && isCanonicalAbsolutePathInsideRoot(physicalPath, entry.path));
            if (nested) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Nested registered worktrees must be removed first' };
        }
        let retainedEntry: string | null = null;
        if (identity) {
            try {
                const lock = (await readFile(join(identity.gitDirPath, 'locked'), 'utf8')).trim();
                if (lock.startsWith('happier-trash:')) retainedEntry = lock.slice('happier-trash:'.length);
            } catch { /* Ordinary worktrees are unlocked. */ }
        }

        await input.context.beforeFilesystemMutation?.(missingWorktree);
        const result = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['worktree', 'remove', '--force', '--force', '--', path],
            timeoutMs: 60_000,
            env: buildScmNonInteractiveEnv(),
        });

        let after = await readPathIdentity(path);
        if (after) {
            const registered = await runScmCommand({ bin: 'git', cwd: input.context.cwd,
                args: ['worktree', 'list', '--porcelain', '-z'], env: buildScmNonInteractiveEnv() });
            const repositoryRoot = registered.success ? await resolveGitMainWorktreePath({
                worktreesOutput: registered.stdout, currentWorktreePath: input.context.detection.rootPath }) : null;
            const guarded = (repositoryRoot !== null && isCanonicalAbsolutePathInsideRoot(join(repositoryRoot, '.dev', 'worktree'), physicalPath))
                || (retainedEntry !== null && basename(path) === 'payload' && basename(dirname(path)) === retainedEntry);
            const registeredPaths = registered.success ? parseGitWorktreeListPorcelain({ worktreesOutput: registered.stdout, currentWorktreePath: null }) : null;
            const fresh = await readPathIdentity(path);
            const repository = identity ? await inspectGitCheckoutIdentity({ cwd: input.context.cwd }) : null;
            const same = before && fresh && before.dev === fresh.dev && before.ino === fresh.ino && fresh.isDirectory() && !fresh.isSymbolicLink()
                && identity && repository && canonicalAbsolutePathsEqual(identity.commonDirPath, repository.commonDirPath);
            if (!guarded || !same || !registeredPaths || registeredPaths.some(entry => canonicalAbsolutePathsEqual(entry.path, physicalPath) || isCanonicalAbsolutePathInsideRoot(physicalPath, entry.path))) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: `Worktree removal left an unverified path: ${path}`, stderr: result.stderr };
            }
            await rm(toNamespacedPath(path), { recursive: true, force: true });
            after = await readPathIdentity(path);
            if (after) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: `Worktree path remains after removal: ${path}` };
            return { success: true, stdout: result.stdout, stderr: result.stderr };
        }

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
    });
}

async function readPathIdentity(path: string) {
    try { return await lstat(toNamespacedPath(path), { bigint: true }); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

export async function gitWorktreePrune(input: {
    context: ScmBackendContext;
    request: ScmWorktreePruneRequest;
}): Promise<ScmWorktreePruneResponse> {
    return withGitWorktreeMutation(input.context.cwd, async () => {
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
    });
}

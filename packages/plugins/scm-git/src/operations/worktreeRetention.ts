import { canonicalizeRepositoryPath, readRepositoryFileSystem } from '../repositoryFileSystem.js';
import { dirname, join } from 'node:path';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode, type ScmWorktreeRetireRequest, type ScmWorktreeRemoveResponse } from '@happier-dev/plugin-sdk/scm';
import { inspectGitCheckoutIdentity } from '../checkoutIdentity.js';
import type { ScmBackendContext } from '../types.js';
import { runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { withGitWorktreeMutation } from './worktreeMutationQueue.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';
import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { readGitRetentionKind } from './worktreeRetentionFacts.js';

type Input = Readonly<{ context: ScmBackendContext; request: ScmWorktreeRetireRequest; signal?: AbortSignal }>;
function failure(error: string, errorCode: ScmOperationErrorCode = SCM_OPERATION_ERROR_CODES.COMMAND_FAILED): ScmWorktreeRemoveResponse {
    return { success: false, error, errorCode };
}
async function absent(path: string): Promise<boolean> {
    try { await readRepositoryFileSystem().lstat(path); return false; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}
async function command(input: Input, args: string[]) {
    return runScmCommand({ bin: 'git', cwd: input.context.cwd, args, timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(), signal: input.signal });
}
async function renameRetained(input: Input, expectedIdentity: Readonly<{ dev: string; ino: string }>) {
    const rename = readCurrentBackendRuntimeServices()?.renamePathNoReplace;
    if (!rename) return failure('The host does not support retained SCM rename', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    await input.context.beforeFilesystemMutation?.();
    await rename({ sourcePath: input.request.worktreePath, targetPath: input.request.targetPath,
        expectedIdentity, signal: input.signal });
    return { success: true };
}
async function completeMoved(input: Input, restoring: boolean): Promise<ScmWorktreeRemoveResponse> {
    const { worktreePath, targetPath, entryId } = input.request;
    if (!input.context.beforeFilesystemMutation)
        return failure('Interrupted worktree completion requires a trusted Trash identity guard', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const before = await readRepositoryFileSystem().lstat(targetPath);
    if (!before.isDirectory() || before.isSymbolicLink()) return failure('The completed worktree is not a directory', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const identity = await inspectGitCheckoutIdentity({ cwd: targetPath });
    const repository = await inspectGitCheckoutIdentity({ cwd: input.context.cwd });
    if (await readGitRetentionKind(targetPath, input.context.cwd, restoring ? targetPath : worktreePath)) {
        await input.context.beforeFilesystemMutation();
        const after = await readRepositoryFileSystem().lstat(targetPath);
        return await absent(worktreePath) && before.dev === after.dev && before.ino === after.ino
            ? { success: true } : failure('The completed checkout identity changed', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    }
    if (!identity || !repository || identity.gitDirPath === identity.commonDirPath
        || !canonicalAbsolutePathsEqual(identity.commonDirPath, repository.commonDirPath))
        return failure('The completed worktree is not owned by this repository', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const physicalTarget = await canonicalizeRepositoryPath(targetPath);
    const listed = await command(input, ['worktree', 'list', '--porcelain', '-z']);
    if (!listed.success) return failure(listed.stderr);
    const registered = parseGitWorktreeListPorcelain({ worktreesOutput: listed.stdout, currentWorktreePath: null });
    if (!registered.some(w => canonicalAbsolutePathsEqual(w.path, physicalTarget))
        || registered.some(w => canonicalAbsolutePathsEqual(w.path, worktreePath)))
        return failure('The completed worktree registration does not match the Trash operation');
    const expected = `happier-trash:${entryId}`;
    let lock: string | null;
    try {
        const files = readRepositoryFileSystem();
        lock = Buffer.from(await files.readFile(files.commandPaths?.fromCommandPath(join(identity.gitDirPath, 'locked')) ?? join(identity.gitDirPath, 'locked'))).toString('utf8').trim();
    }
    catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
            return failure('The completed worktree lock is unavailable');
        lock = null;
    }
    if (lock !== null && lock !== expected) return failure('The worktree lock belongs to another owner');
    await input.context.beforeFilesystemMutation();
    const after = await readRepositoryFileSystem().lstat(targetPath);
    if (!await absent(worktreePath) || before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink())
        return failure('The completed worktree identity changed', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    if ((restoring && lock === null) || (!restoring && lock === expected)) return { success: true };
    const result = await command(input, restoring ? ['worktree', 'unlock', '--', targetPath]
        : ['worktree', 'lock', '--reason', expected, '--', targetPath]);
    return result.success ? { success: true, stdout: result.stdout, stderr: result.stderr } : failure(result.stderr);
}
async function move(input: Input, restoring: boolean): Promise<ScmWorktreeRemoveResponse> {
    const { worktreePath, targetPath, entryId } = input.request;
    if (!worktreePath.trim() || !targetPath.trim() || !entryId.trim() || /[\r\n\0]/u.test(entryId))
        return failure('Invalid worktree retention request', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    input.context.assertFilesystemPathAuthorized?.(worktreePath);
    input.context.assertFilesystemPathAuthorized?.(targetPath);
    if (await absent(worktreePath) && !await absent(targetPath)) return completeMoved(input, restoring);
    if (!await absent(targetPath)) return failure(`Restore destination is occupied: ${targetPath}`, SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    if (await absent(dirname(targetPath))) return failure('The destination parent is missing', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const sourceInfo = await readRepositoryFileSystem().lstat(worktreePath);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) return failure('A worktree source must be a directory', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const physicalSource = await canonicalizeRepositoryPath(worktreePath);
    const identity = await inspectGitCheckoutIdentity({ cwd: worktreePath });
    const repository = await inspectGitCheckoutIdentity({ cwd: input.context.cwd });
    if (await readGitRetentionKind(physicalSource, input.context.cwd, restoring ? targetPath : worktreePath)) {
        if (isCanonicalAbsolutePathInsideRoot(physicalSource, targetPath))
            return failure('A checkout cannot be retained inside itself', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
        // Moving a main checkout retains its common directory and registrations as-is.
        // Dependent worktrees are unavailable until exact Undo restores that authority.
        return renameRetained(input, { dev: String(sourceInfo.dev), ino: String(sourceInfo.ino) });
    }
    if (!identity || identity.gitDirPath === identity.commonDirPath) return failure('The source is not a proved SCM checkout');
    if (!repository || !canonicalAbsolutePathsEqual(repository.commonDirPath, identity.commonDirPath))
        return failure('The worktree belongs to another repository', SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    const listed = await command(input, ['worktree', 'list', '--porcelain', '-z']);
    if (!listed.success) return failure(listed.stderr);
    const registered = parseGitWorktreeListPorcelain({ worktreesOutput: listed.stdout, currentWorktreePath: null });
    if (!registered.some(w => canonicalAbsolutePathsEqual(w.path, physicalSource))) return failure('The worktree is no longer registered');
    if (registered.some(w => !canonicalAbsolutePathsEqual(w.path, physicalSource) && isCanonicalAbsolutePathInsideRoot(physicalSource, w.path)))
        return failure('Nested registered worktrees must be retired first', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    const lockReason = `happier-trash:${entryId}`;
    if (restoring) {
        let locked: string;
        try {
            const files = readRepositoryFileSystem();
            locked = Buffer.from(await files.readFile(files.commandPaths?.fromCommandPath(join(identity.gitDirPath, 'locked')) ?? join(identity.gitDirPath, 'locked'))).toString('utf8').trim();
        }
        catch { return failure('The retired worktree lock is unavailable'); }
        if (locked !== lockReason) return failure('The retired worktree belongs to another Trash entry');
        await input.context.beforeFilesystemMutation?.();
        const unlock = await command(input, ['worktree', 'unlock', '--', worktreePath]);
        if (!unlock.success) return failure(unlock.stderr);
    } else {
        const submodules = await command(input, ['-C', worktreePath, 'ls-files', '--stage', '-z']);
        if (!submodules.success) return failure(submodules.stderr);
        if (submodules.stdout.split('\0').some(entry => entry.startsWith('160000 ')))
            return failure('Worktree has submodules; only Delete now is supported', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        await input.context.beforeFilesystemMutation?.();
    }
    // Git otherwise interprets a newly occupied directory as a parent and moves into its child.
    if (!await absent(targetPath) || await absent(dirname(targetPath))) {
        if (restoring) await command(input, ['worktree', 'lock', '--reason', lockReason, '--', worktreePath]);
        return failure(`Restore destination is occupied or its parent is missing: ${targetPath}`, SCM_OPERATION_ERROR_CODES.INVALID_PATH);
    }
    const moved = await command(input, ['worktree', 'move', '--', worktreePath, targetPath]);
    if (!moved.success) {
        if (restoring) await command(input, ['worktree', 'lock', '--reason', lockReason, '--', worktreePath]);
        return failure(moved.stderr || 'Failed to move worktree');
    }
    if (!restoring) {
        const lock = await command(input, ['worktree', 'lock', '--reason', lockReason, '--', targetPath]);
        if (!lock.success) {
            const rollback = await command(input, ['worktree', 'move', '--', targetPath, worktreePath]);
            return failure(`${lock.stderr}${rollback.success ? '' : `; rollback failed: ${rollback.stderr}`}`);
        }
    }
    return { success: true, stdout: moved.stdout, stderr: moved.stderr };
}
export function gitWorktreeRetire(input: Input) {
    return withGitWorktreeMutation(input.context.cwd, () => move(input, false));
}
export function gitWorktreeReinstate(input: Input) {
    return withGitWorktreeMutation(input.context.cwd, () => move(input, true));
}

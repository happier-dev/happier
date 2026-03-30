import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { ensureGitWorktreeMaterialized } from './ensureGitWorktreeMaterialized';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference';
import { isGitWorkspaceTransferMetadata } from '../workspaceTransferMetadata';

const LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX =
    /local changes.*would be overwritten|untracked working tree files.*would be overwritten|please commit your changes or stash them/i;

async function hasCommitObject(cwd: string, revision: string): Promise<boolean> {
    const result = await runScmCommand({
        bin: 'git',
        cwd,
        args: ['cat-file', '-e', `${revision}^{commit}`],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success;
}

async function fetchSourceBranchIntoTarget(input: Readonly<{
    targetPath: string;
    sourcePath: string;
    sourceBranchName: string;
}>): Promise<boolean> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.targetPath,
        args: ['fetch', '--no-tags', '--quiet', input.sourcePath, input.sourceBranchName],
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success;
}

async function hasLocalBranchRef(targetPath: string, branchName: string): Promise<boolean> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: targetPath,
        args: ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success;
}

function normalizeGitLocalRemotePath(candidate: string, cwd: string): string | null {
    const trimmed = candidate.trim();
    if (!trimmed) {
        return null;
    }

    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
        return trimmed;
    }

    if (trimmed.startsWith('file://')) {
        try {
            return new URL(trimmed).pathname;
        } catch {
            return null;
        }
    }

    if (trimmed.includes('://') || /^[^/]+@[^:]+:/.test(trimmed)) {
        return null;
    }

    return trimmed.startsWith('/') ? trimmed : join(cwd, trimmed);
}

async function previousTargetLooksLikePlainGitCloneOfSource(input: Readonly<{
    previousTargetPath: string;
    sourcePath: string;
}>): Promise<boolean> {
    const remoteUrlResult = await runScmCommand({
        bin: 'git',
        cwd: input.previousTargetPath,
        args: ['config', '--get', 'remote.origin.url'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!remoteUrlResult.success) {
        return false;
    }

    const remotePath = normalizeGitLocalRemotePath(remoteUrlResult.stdout, input.previousTargetPath);
    if (!remotePath) {
        return false;
    }

    return remotePath === input.sourcePath;
}

async function updateHeadSymbolicRefToBranch(input: Readonly<{
    targetPath: string;
    branchName: string;
    branchHeadRevision: string | null;
}>): Promise<void> {
    if (input.branchHeadRevision) {
        const updateRefResult = await runScmCommand({
            bin: 'git',
            cwd: input.targetPath,
            args: ['update-ref', `refs/heads/${input.branchName}`, input.branchHeadRevision],
            timeoutMs: 10_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!updateRefResult.success) {
            throw new Error(updateRefResult.stderr || updateRefResult.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        }
    } else if (await hasLocalBranchRef(input.targetPath, input.branchName)) {
        const deleteRefResult = await runScmCommand({
            bin: 'git',
            cwd: input.targetPath,
            args: ['update-ref', '-d', `refs/heads/${input.branchName}`],
            timeoutMs: 10_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!deleteRefResult.success) {
            throw new Error(deleteRefResult.stderr || deleteRefResult.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        }
    }

    const symbolicRefResult = await runScmCommand({
        bin: 'git',
        cwd: input.targetPath,
        args: ['symbolic-ref', 'HEAD', `refs/heads/${input.branchName}`],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!symbolicRefResult.success) {
        throw new Error(symbolicRefResult.stderr || symbolicRefResult.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    }
}

function isSafeNoopCheckoutFailure(stderr: string): boolean {
    const normalized = stderr.toLowerCase();
    return LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX.test(normalized)
        || normalized.includes('would be overwritten by checkout')
        || normalized.includes('you need to resolve your current index first');
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function restoreGitAdminState(input: Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
}>): Promise<void> {
    const previousTargetPath = typeof input.previousTargetPath === 'string' ? input.previousTargetPath.trim() : '';
    if (!previousTargetPath) {
        return;
    }

    const previousGitPath = join(previousTargetPath, '.git');
    if (!(await pathExists(previousGitPath))) {
        return;
    }

    const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath.trim() : '';
    const [previousTargetIdentity, targetIdentity] = await Promise.all([
        inspectGitCheckoutIdentity({ cwd: previousTargetPath }),
        inspectGitCheckoutIdentity({ cwd: input.targetPath }),
    ]);
    if (!previousTargetIdentity) {
        return;
    }

    if (sourcePath) {
        const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourcePath });
        if (
            sourceIdentity
            && isGitLinkedWorktreeIdentity(sourceIdentity)
            && isGitLinkedWorktreeIdentity(previousTargetIdentity)
            && sourceIdentity.commonDirPath !== previousTargetIdentity.commonDirPath
        ) {
            return;
        }
        if (
            sourceIdentity
            && (!isGitLinkedWorktreeIdentity(sourceIdentity) || !isGitLinkedWorktreeIdentity(previousTargetIdentity))
            && sourceIdentity.gitDirPath !== previousTargetIdentity.gitDirPath
        ) {
            if (
                targetIdentity !== null
                || !await previousTargetLooksLikePlainGitCloneOfSource({
                    previousTargetPath,
                    sourcePath,
                })
            ) {
                return;
            }
        }
        if (!sourceIdentity && targetIdentity !== null) {
            return;
        }
    } else if (targetIdentity) {
        if (isGitLinkedWorktreeIdentity(targetIdentity) && isGitLinkedWorktreeIdentity(previousTargetIdentity)) {
            if (targetIdentity.commonDirPath !== previousTargetIdentity.commonDirPath) {
                return;
            }
            if (
                targetIdentity.gitDirPath === previousTargetIdentity.gitDirPath
                && targetIdentity.registeredWorktreePath === input.targetPath
            ) {
                return;
            }
        } else if (targetIdentity.gitDirPath === previousTargetIdentity.gitDirPath) {
            return;
        }
    }

    const nextGitPath = join(input.targetPath, '.git');
    if (await pathExists(nextGitPath)) {
        await rm(nextGitPath, { recursive: true, force: true });
    }

    await rename(previousGitPath, nextGitPath);
    const repairedTargetIdentity = await inspectGitCheckoutIdentity({ cwd: input.targetPath });
    if (!repairedTargetIdentity) {
        return;
    }

    if (!isGitLinkedWorktreeIdentity(repairedTargetIdentity)) {
        return;
    }

    await repairGitWorktreeAdminReference({
        identity: repairedTargetIdentity,
        targetPath: input.targetPath,
    });
}

export async function reconcileGitWorkspaceCheckout(input: Readonly<{
    context: ScmBackendContext;
    sourcePath?: string;
    previousTargetPath?: string;
    sourceControllerMetadata?: Readonly<Record<string, unknown>>;
}>): Promise<void> {
    await ensureGitWorktreeMaterialized({
        targetPath: input.context.cwd,
        sourcePath: input.sourcePath,
        previousTargetPath: input.previousTargetPath,
    });

    await restoreGitAdminState({
        targetPath: input.context.cwd,
        sourcePath: input.sourcePath,
        previousTargetPath: input.previousTargetPath,
    });

    const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath.trim() : '';
    const sourceMetadata = isGitWorkspaceTransferMetadata(input.sourceControllerMetadata)
        ? input.sourceControllerMetadata
        : null;

    const targetIdentity = await inspectGitCheckoutIdentity({ cwd: input.context.cwd });
    const targetBranchName = targetIdentity?.branchName ?? null;
    const targetHeadRevision = targetIdentity?.headRevision ?? null;
    if (!targetBranchName && !targetHeadRevision) {
        return;
    }

    if (!sourcePath) {
        if (!sourceMetadata) {
            return;
        }

        if (sourceMetadata.checkoutKind === 'detached') {
            if (!await hasCommitObject(input.context.cwd, sourceMetadata.headRevision)) {
                return;
            }

            await runScmCommand({
                bin: 'git',
                cwd: input.context.cwd,
                args: ['update-ref', '--no-deref', 'HEAD', sourceMetadata.headRevision],
            });
            return;
        }

        if (targetBranchName === sourceMetadata.branchName) {
            if (sourceMetadata.headRevision && targetHeadRevision === sourceMetadata.headRevision) {
                return;
            }
        }

        const branchHeadRevision = sourceMetadata.headRevision
            ? (await hasCommitObject(input.context.cwd, sourceMetadata.headRevision)
                ? sourceMetadata.headRevision
                : targetHeadRevision)
            : null;

        await updateHeadSymbolicRefToBranch({
            targetPath: input.context.cwd,
            branchName: sourceMetadata.branchName,
            branchHeadRevision,
        });
        return;
    }

    const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourcePath });
    if (!sourceIdentity?.branchName) {
        return;
    }

    const sourceBranchName = sourceIdentity.branchName;
    const sourceHeadRevision = sourceIdentity.headRevision;


    if (targetBranchName === sourceBranchName && targetHeadRevision === sourceHeadRevision) {
        return;
    }

    const canRealignToSourceHead = sourceHeadRevision
        ? await hasCommitObject(input.context.cwd, sourceHeadRevision)
            || (await fetchSourceBranchIntoTarget({
                targetPath: input.context.cwd,
                sourcePath,
                sourceBranchName,
            }) && await hasCommitObject(input.context.cwd, sourceHeadRevision))
        : false;

    if (!sourceHeadRevision && targetHeadRevision) {
        return;
    }

    const checkoutArgs = canRealignToSourceHead && sourceHeadRevision
        ? ['checkout', '-f', '-B', sourceBranchName, sourceHeadRevision]
        : ['checkout', '-f', '-B', sourceBranchName];

    const checkoutResult = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: checkoutArgs,
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (checkoutResult.success) {
        return;
    }

    if (isSafeNoopCheckoutFailure(checkoutResult.stderr)) {
        return;
    }

    throw new Error(
        checkoutResult.stderr
        || checkoutResult.stdout
        || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    );
}

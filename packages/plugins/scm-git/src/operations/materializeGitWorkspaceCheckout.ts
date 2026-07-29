import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/experimental/scm';

import { normalizeCommitRef, runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference.js';
import {
    buildWorktreeTargetPath,
    hasForbiddenGitRefName,
    normalizeWorktreeDisplayName,
} from './worktreeName.js';

type GitWorkspaceCheckoutCreationInput = Readonly<{
    repoRoot: string;
    displayName: string;
    baseRef: string | null;
}>;

function resolveNormalizedBaseRef(baseRef: string | null): string | null {
    if (baseRef == null) {
        return null;
    }

    const normalized = normalizeCommitRef(baseRef);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }

    return normalized.commit;
}

function resolveWorktreeBranchName(displayName: string): string {
    if (displayName.trim() && hasForbiddenGitRefName(displayName)) {
        throw new Error('Invalid Git worktree name');
    }

    const branchName = normalizeWorktreeDisplayName(displayName);
    if (!branchName) {
        throw new Error('Workspace checkout display name is required');
    }

    return branchName;
}

async function runGitWorktreeAdd(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
}>): Promise<void> {
    await mkdir(dirname(input.targetPath), { recursive: true });

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.repoRoot,
        args: [
            'worktree',
            'add',
            '-b',
            input.branchName,
            '--',
            input.targetPath,
            ...(input.baseRef ? [input.baseRef] : []),
        ],
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (result.success) {
        return;
    }

    throw new Error(result.stderr || result.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
    if (!(await pathExists(path))) {
        return true;
    }

    return (await readdir(path)).length === 0;
}

async function materializeGitWorktreeIntoExistingDirectory(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
}>): Promise<string> {
    const temporaryTargetPath = `${input.targetPath}.happier-materialize-tmp`;
    await rm(temporaryTargetPath, { recursive: true, force: true });

    await runGitWorktreeAdd({
        repoRoot: input.repoRoot,
        targetPath: temporaryTargetPath,
        branchName: input.branchName,
        baseRef: input.baseRef,
    });

    try {
        const temporaryIdentity = await inspectGitCheckoutIdentity({ cwd: temporaryTargetPath });
        if (!temporaryIdentity) {
            throw new Error('Failed to inspect temporary git worktree identity');
        }

        await rename(join(temporaryTargetPath, '.git'), join(input.targetPath, '.git'));
        await repairGitWorktreeAdminReference({
            identity: temporaryIdentity,
            targetPath: input.targetPath,
        });

        return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
    } finally {
        await rm(temporaryTargetPath, { recursive: true, force: true });
    }
}

async function resolveGitMaterializedWorktreeTargetPath(input: Readonly<{
    targetPath: string;
}>): Promise<string> {
    const identity = await inspectGitCheckoutIdentity({ cwd: input.targetPath });
    return identity?.registeredWorktreePath ?? identity?.worktreePath ?? input.targetPath;
}

async function tryReuseExistingGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
}>): Promise<string | null> {
    const [repoIdentity, targetIdentity] = await Promise.all([
        inspectGitCheckoutIdentity({ cwd: input.repoRoot }),
        inspectGitCheckoutIdentity({ cwd: input.targetPath }),
    ]);
    if (
        !repoIdentity
        || !targetIdentity
        || !isGitLinkedWorktreeIdentity(targetIdentity)
        || targetIdentity.commonDirPath !== repoIdentity.commonDirPath
        || targetIdentity.branchName !== input.branchName
    ) {
        return null;
    }

    await repairGitWorktreeAdminReference({
        identity: targetIdentity,
        targetPath: input.targetPath,
    });

    return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
}

function isAlreadyExistsFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('already exists');
}

export async function materializeGitWorkspaceCheckoutAtPath(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
}>): Promise<Readonly<{
    targetPath: string;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);

    const reusedTargetPath = await tryReuseExistingGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
    });
    if (reusedTargetPath) {
        return {
            targetPath: reusedTargetPath,
        };
    }

    const normalizedBaseRef = resolveNormalizedBaseRef(input.baseRef);
    if (!await isDirectoryEmpty(input.targetPath)) {
        return {
            targetPath: await materializeGitWorktreeIntoExistingDirectory({
                repoRoot: input.repoRoot,
                targetPath: input.targetPath,
                branchName,
                baseRef: normalizedBaseRef,
            }),
        };
    }

    await runGitWorktreeAdd({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
        baseRef: normalizedBaseRef,
    });

    return {
        targetPath: await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath }),
    };
}

export async function createGitWorkspaceCheckoutAtDefaultPath(
    input: GitWorkspaceCheckoutCreationInput,
): Promise<Readonly<{
    targetPath: string;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);

    const normalizedBaseRef = resolveNormalizedBaseRef(input.baseRef);

    for (let suffix = 1; suffix <= 4; suffix += 1) {
        const candidateBranchName = suffix === 1 ? branchName : `${branchName}-${suffix}`;
        const candidateTargetPath = buildWorktreeTargetPath(input.repoRoot, candidateBranchName);
        try {
            const materialized = await materializeGitWorkspaceCheckoutAtPath({
                repoRoot: input.repoRoot,
                targetPath: candidateTargetPath,
                displayName: candidateBranchName,
                baseRef: normalizedBaseRef,
            });
            return {
                targetPath: materialized.targetPath,
            };
        } catch (error) {
            if (suffix < 4 && isAlreadyExistsFailure(error)) {
                continue;
            }
            throw error;
        }
    }

    throw new Error('Failed to create workspace checkout');
}

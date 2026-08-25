import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { normalizeCommitRef, runScmCommand } from '../runtime.js';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference.js';
import {
    buildWorktreeTargetPath,
    hasForbiddenGitRefName,
    normalizeWorktreeDisplayName,
} from './worktreeName.js';
import {
    GIT_WORKTREE_NAME_ATTEMPT_LIMIT,
    gitWorktreeNameForAttempt,
    isGitWorktreeAlreadyExistsFailure,
    runGitWorktreeAdd as runCanonicalGitWorktreeAdd,
} from './gitWorktreeAdd.js';

type GitWorkspaceCheckoutCreationInput = Readonly<{
    repoRoot: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
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

/**
 * Adds the worktree through the package's one `git worktree add` owner and
 * turns its failure into the throw this materializer's callers already handle.
 * The parent directory is prepared here because only this caller materializes
 * into an explicitly chosen absolute path.
 */
async function addGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>): Promise<void> {
    await mkdir(dirname(input.targetPath), { recursive: true });

    const result = await runCanonicalGitWorktreeAdd({
        repoRoot: input.repoRoot,
        worktreePath: input.targetPath,
        branchName: input.branchName,
        branchMode: input.branchMode,
        baseRef: input.baseRef,
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
    branchMode: 'new' | 'existing';
}>): Promise<string> {
    const temporaryTargetPath = `${input.targetPath}.happier-materialize-tmp`;
    await rm(temporaryTargetPath, { recursive: true, force: true });

    await addGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: temporaryTargetPath,
        branchName: input.branchName,
        baseRef: input.baseRef,
        branchMode: input.branchMode,
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
    if (!await pathExists(input.targetPath)) {
        return null;
    }
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

async function tryReuseGitWorktreeByBranch(input: Readonly<{
    repoRoot: string;
    branchName: string;
}>): Promise<string | null> {
    const listed = await runScmCommand({
        bin: 'git',
        cwd: input.repoRoot,
        args: ['worktree', 'list', '--porcelain'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!listed.success) return null;

    return parseGitWorktreeListPorcelain({
        worktreesOutput: listed.stdout,
        currentWorktreePath: input.repoRoot,
        mainWorktreePath: input.repoRoot,
    }).find((worktree) => worktree.branch === input.branchName)?.path ?? null;
}

export async function materializeGitWorkspaceCheckoutAtPath(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    reused: boolean;
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
            branchName,
            reused: true,
        };
    }

    if (input.branchMode === 'existing') {
        const existingBranchPath = await tryReuseGitWorktreeByBranch({
            repoRoot: input.repoRoot,
            branchName,
        });
        if (existingBranchPath) {
            return {
                targetPath: existingBranchPath,
                branchName,
                reused: true,
            };
        }
    }

    const normalizedBaseRef = input.branchMode === 'existing'
        ? null
        : resolveNormalizedBaseRef(input.baseRef);
    if (!await isDirectoryEmpty(input.targetPath)) {
        return {
            targetPath: await materializeGitWorktreeIntoExistingDirectory({
                repoRoot: input.repoRoot,
                targetPath: input.targetPath,
                branchName,
                baseRef: normalizedBaseRef,
                branchMode: input.branchMode,
            }),
            branchName,
            reused: false,
        };
    }

    await addGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
        baseRef: normalizedBaseRef,
        branchMode: input.branchMode,
    });

    return {
        targetPath: await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath }),
        branchName,
        reused: false,
    };
}

export async function createGitWorkspaceCheckoutAtDefaultPath(
    input: GitWorkspaceCheckoutCreationInput,
): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    reused: boolean;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);

    const normalizedBaseRef = input.branchMode === 'existing'
        ? null
        : resolveNormalizedBaseRef(input.baseRef);

    for (let attempt = 1; attempt <= GIT_WORKTREE_NAME_ATTEMPT_LIMIT; attempt += 1) {
        const candidateBranchName = gitWorktreeNameForAttempt(branchName, attempt);
        const candidateTargetPath = buildWorktreeTargetPath(input.repoRoot, candidateBranchName);
        try {
            const materialized = await materializeGitWorkspaceCheckoutAtPath({
                repoRoot: input.repoRoot,
                targetPath: candidateTargetPath,
                displayName: candidateBranchName,
                baseRef: normalizedBaseRef,
                branchMode: input.branchMode,
            });
            return {
                targetPath: materialized.targetPath,
                branchName: materialized.branchName,
                reused: materialized.reused,
            };
        } catch (error) {
            if (
                input.branchMode === 'new'
                && attempt < GIT_WORKTREE_NAME_ATTEMPT_LIMIT
                && isGitWorktreeAlreadyExistsFailure(error)
            ) {
                continue;
            }
            throw error;
        }
    }

    throw new Error('Failed to create workspace checkout');
}

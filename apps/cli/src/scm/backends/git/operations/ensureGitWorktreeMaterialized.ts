import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference';

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

function normalizeOptionalPath(path: string | undefined): string {
    return typeof path === 'string' ? path.trim() : '';
}

export async function ensureGitWorktreeMaterialized(input: Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
}>): Promise<void> {
    const previousTargetPath = normalizeOptionalPath(input.previousTargetPath);
    const sourcePath = normalizeOptionalPath(input.sourcePath);
    if (!previousTargetPath || !sourcePath) {
        return;
    }

    const [sourceIdentity, previousTargetIdentity, targetIdentity] = await Promise.all([
        inspectGitCheckoutIdentity({ cwd: sourcePath }),
        inspectGitCheckoutIdentity({ cwd: previousTargetPath }),
        inspectGitCheckoutIdentity({ cwd: input.targetPath }),
    ]);
    if (!previousTargetIdentity || !isGitLinkedWorktreeIdentity(previousTargetIdentity)) {
        return;
    }

    if (sourceIdentity && sourceIdentity.commonDirPath !== previousTargetIdentity.commonDirPath) {
        return;
    }

    if (!sourceIdentity && targetIdentity !== null) {
        return;
    }

    if (targetIdentity?.gitDirPath === previousTargetIdentity.gitDirPath) {
        return;
    }

    const previousGitPath = join(previousTargetPath, '.git');
    if (!(await pathExists(previousGitPath))) {
        return;
    }

    const targetGitPath = join(input.targetPath, '.git');
    if (await pathExists(targetGitPath)) {
        await rm(targetGitPath, { recursive: true, force: true });
    }

    await rename(previousGitPath, targetGitPath);
    await repairGitWorktreeAdminReference({
        identity: previousTargetIdentity,
        targetPath: input.targetPath,
    });
}

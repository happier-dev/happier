import { cp, lstat } from 'node:fs/promises';

import type { ScmSourceControllerWorkspaceTransferConflictPolicy } from './workspaceTransfer';
import { resolveWorkspaceMaterializationTargetPath } from './workspaceMaterializationTargetPath';

function isMissingPathError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (isMissingPathError(error)) {
            return false;
        }
        throw error;
    }
}

export async function prepareWorkspaceSyncTargetPath(params: Readonly<{
    targetPath: string;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    siblingCopySuffixBase: string;
}>): Promise<Readonly<{
    resolvedTargetPath: string;
    cleanupOnFailure: boolean;
    previousTargetPath?: string;
}>> {
    const resolvedTargetPath = await resolveWorkspaceMaterializationTargetPath({
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        naming: {
            siblingCopySuffixBase: params.siblingCopySuffixBase,
        },
    });

    if (resolvedTargetPath === params.targetPath) {
        return {
            resolvedTargetPath,
            cleanupOnFailure: false,
        };
    }

    if (!(await pathExists(params.targetPath))) {
        return {
            resolvedTargetPath,
            cleanupOnFailure: false,
        };
    }

    await cp(params.targetPath, resolvedTargetPath, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
    });

    return {
        resolvedTargetPath,
        cleanupOnFailure: true,
        previousTargetPath: params.targetPath,
    };
}

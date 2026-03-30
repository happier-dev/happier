import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

import type { ScmSourceControllerWorkspaceTransferConflictPolicy } from './workspaceTransfer';

export type WorkspaceMaterializationNaming = Readonly<{
    siblingCopySuffixBase: string;
}>;

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function resolveNearestExistingAncestor(path: string): Promise<string> {
    let currentPath = path;
    while (!(await pathExists(currentPath))) {
        const parentPath = dirname(currentPath);
        if (parentPath === currentPath) {
            return currentPath;
        }
        currentPath = parentPath;
    }
    return currentPath;
}

async function canCreateWithinTargetPath(path: string): Promise<boolean> {
    const ancestorPath = await resolveNearestExistingAncestor(path);
    try {
        const stats = await lstat(ancestorPath);
        if (!stats.isDirectory()) {
            return false;
        }
        await access(ancestorPath, constants.W_OK | constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function resolveFallbackWorkspaceTargetPath(targetPath: string): string {
    const parsed = parse(targetPath);
    return join(homedir(), parsed.base || parsed.name || 'workspace');
}

export async function resolveWorkspaceMaterializationTargetPath(params: Readonly<{
    targetPath: string;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    naming: WorkspaceMaterializationNaming;
}>): Promise<string> {
    const requestedTargetPath = params.targetPath;
    const targetPath = (!(await pathExists(requestedTargetPath)) && !(await canCreateWithinTargetPath(requestedTargetPath)))
        ? resolveFallbackWorkspaceTargetPath(requestedTargetPath)
        : requestedTargetPath;

    if (!(await pathExists(targetPath))) {
        return targetPath;
    }
    if (params.conflictPolicy === 'replace_existing' && targetPath === requestedTargetPath) {
        return targetPath;
    }

    const parsed = parse(targetPath);
    const baseName = parsed.name || parsed.base || 'workspace';
    const extension = parsed.ext ?? '';
    for (let index = 1; index < 1000; index += 1) {
        const suffix = index === 1
            ? `-${params.naming.siblingCopySuffixBase}`
            : `-${params.naming.siblingCopySuffixBase}-${index}`;
        const candidate = join(parsed.dir, `${baseName}${suffix}${extension}`);
        if (await pathExists(candidate)) {
            continue;
        }
        return candidate;
    }

    throw new Error(`Unable to resolve a sibling workspace copy for ${params.targetPath}`);
}

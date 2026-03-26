import { randomUUID } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

import type { WorkspaceManifestEntry } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import { assertPortableWorkspaceEntriesWithSourceController } from '@/scm/sourceController/workspacePortability';
import { applyWorkspaceMetadata } from '@/scm/sourceController/workspaceExportStaging/applyWorkspaceMetadata';
import { cleanupWorkspaceStaging } from '@/scm/sourceController/workspaceExportStaging/cleanupWorkspaceStaging';
import { createWorkspaceStagingRoot } from '@/scm/sourceController/workspaceExportStaging/createWorkspaceStagingRoot';
import {
    stageWorkspaceEntries,
    type WorkspaceExportBlobProvider,
} from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import {
    assertWorkspaceMaterializationSymlinkTarget,
    resolveContainedWorkspaceMaterializationPath,
} from '@/scm/sourceController/workspaceMaterializationSafety';

import type { WorkspaceSyncArtifacts } from './workspaceSyncArtifacts';

type WorkspaceFileEntry = Extract<WorkspaceManifestEntry, { kind: 'file' }>;
type WorkspaceDirectoryEntry = Extract<WorkspaceManifestEntry, { kind: 'directory' }>;
type WorkspaceSymlinkEntry = Extract<WorkspaceManifestEntry, { kind: 'symlink' }>;
type WorkspaceSyncRollbackEntry = Readonly<{
    relativePath: string;
    existed: boolean;
}>;
type WorkspaceSyncRollbackState = Readonly<{
    backupRoot: string;
    entries: Map<string, WorkspaceSyncRollbackEntry>;
}>;

function isMissingPathError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function resolveTargetWorkspacePath(params: Readonly<{
    workspaceRoot: string;
    relativePath: string;
}>): string {
    return resolveContainedWorkspaceMaterializationPath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: params.relativePath,
        errorMessage: `Workspace transfer path escapes target: ${params.relativePath}`,
    });
}

function createWorkspaceSyncRollbackState(backupRoot: string): WorkspaceSyncRollbackState {
    return {
        backupRoot,
        entries: new Map(),
    };
}

function collectRelativePathAncestors(relativePath: string): readonly string[] {
    const segments = relativePath.split('/').filter((segment) => segment.length > 0);
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function hasTrackedAncestor(params: Readonly<{
    rollback: WorkspaceSyncRollbackState;
    relativePath: string;
}>): boolean {
    return collectRelativePathAncestors(params.relativePath).some((ancestorRelativePath) => params.rollback.entries.has(ancestorRelativePath));
}

async function backupWorkspacePathForRollback(params: Readonly<{
    rollback: WorkspaceSyncRollbackState;
    workspaceRoot: string;
    relativePath: string;
}>): Promise<void> {
    if (params.rollback.entries.has(params.relativePath) || hasTrackedAncestor(params)) {
        return;
    }

    const targetPath = resolveTargetWorkspacePath({
        workspaceRoot: params.workspaceRoot,
        relativePath: params.relativePath,
    });

    try {
        await lstat(targetPath);
    } catch (error) {
        if (isMissingPathError(error)) {
            params.rollback.entries.set(params.relativePath, {
                relativePath: params.relativePath,
                existed: false,
            });
            return;
        }
        throw error;
    }

    const backupPath = resolveTargetWorkspacePath({
        workspaceRoot: params.rollback.backupRoot,
        relativePath: params.relativePath,
    });
    await mkdir(dirname(backupPath), { recursive: true });
    await cp(targetPath, backupPath, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
    });
    params.rollback.entries.set(params.relativePath, {
        relativePath: params.relativePath,
        existed: true,
    });
}

async function rollbackWorkspaceSyncMutations(params: Readonly<{
    rollback: WorkspaceSyncRollbackState;
    workspaceRoot: string;
    targetWorkspaceRootInitiallyExisted: boolean;
}>): Promise<void> {
    const rollbackEntries = [...params.rollback.entries.values()];
    const sortByDepthDescending = (left: WorkspaceSyncRollbackEntry, right: WorkspaceSyncRollbackEntry): number => {
        const leftDepth = left.relativePath.split('/').length;
        const rightDepth = right.relativePath.split('/').length;
        return rightDepth - leftDepth || right.relativePath.localeCompare(left.relativePath);
    };
    const sortByDepthAscending = (left: WorkspaceSyncRollbackEntry, right: WorkspaceSyncRollbackEntry): number => {
        const leftDepth = left.relativePath.split('/').length;
        const rightDepth = right.relativePath.split('/').length;
        return leftDepth - rightDepth || left.relativePath.localeCompare(right.relativePath);
    };

    for (const entry of rollbackEntries.sort(sortByDepthDescending)) {
        await removeWorkspacePathIfExists(resolveTargetWorkspacePath({
            workspaceRoot: params.workspaceRoot,
            relativePath: entry.relativePath,
        }));
    }

    for (const entry of rollbackEntries.filter((candidate) => candidate.existed).sort(sortByDepthAscending)) {
        const backupPath = resolveTargetWorkspacePath({
            workspaceRoot: params.rollback.backupRoot,
            relativePath: entry.relativePath,
        });
        const targetPath = resolveTargetWorkspacePath({
            workspaceRoot: params.workspaceRoot,
            relativePath: entry.relativePath,
        });
        await mkdir(dirname(targetPath), { recursive: true });
        await cp(backupPath, targetPath, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
        });
    }

    if (!params.targetWorkspaceRootInitiallyExisted && params.rollback.entries.size === 0) {
        await rm(params.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function removeWorkspacePathIfExists(path: string): Promise<void> {
    try {
        await lstat(path);
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        throw error;
    }

    await rm(path, { recursive: true, force: true });
}

async function ensureWorkspaceParentDirectory(params: Readonly<{
    workspaceRoot: string;
    entryRelativePath: string;
    rollback?: WorkspaceSyncRollbackState;
}>): Promise<void> {
    const parentRelativePath = parse(params.entryRelativePath).dir;
    if (!parentRelativePath) {
        return;
    }

    const segments = parentRelativePath.split('/').filter((segment) => segment.length > 0);
    let currentRelativePath = '';

    for (const segment of segments) {
        currentRelativePath = currentRelativePath ? join(currentRelativePath, segment) : segment;
        const currentPath = resolveTargetWorkspacePath({
            workspaceRoot: params.workspaceRoot,
            relativePath: currentRelativePath,
        });

        try {
            const stats = await lstat(currentPath);
            if (stats.isDirectory()) {
                continue;
            }
            if (params.rollback) {
                await backupWorkspacePathForRollback({
                    rollback: params.rollback,
                    workspaceRoot: params.workspaceRoot,
                    relativePath: currentRelativePath,
                });
            }
            await rm(currentPath, { recursive: true, force: true });
        } catch (error) {
            if (!isMissingPathError(error)) {
                throw error;
            }
            if (params.rollback) {
                await backupWorkspacePathForRollback({
                    rollback: params.rollback,
                    workspaceRoot: params.workspaceRoot,
                    relativePath: currentRelativePath,
                });
            }
        }

        await mkdir(currentPath, { recursive: true });
    }
}

async function ensureTargetWorkspaceRoot(targetPath: string): Promise<void> {
    try {
        const stats = await lstat(targetPath);
        if (!stats.isDirectory()) {
            throw new Error(`Workspace sync target must be a directory: ${targetPath}`);
        }
        return;
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
    }

    await mkdir(targetPath, { recursive: true });
}

function assertSyncArtifactsStayWithinTarget(params: Readonly<{
    targetPath: string;
    syncArtifacts: WorkspaceSyncArtifacts;
}>): void {
    for (const relativePath of params.syncArtifacts.removedRelativePaths) {
        resolveTargetWorkspacePath({
            workspaceRoot: params.targetPath,
            relativePath,
        });
    }

    for (const entry of params.syncArtifacts.changedWorkspaceArtifacts.manifest.entries) {
        const targetEntryPath = resolveTargetWorkspacePath({
            workspaceRoot: params.targetPath,
            relativePath: entry.relativePath,
        });
        if (entry.kind !== 'symlink') {
            continue;
        }
        assertWorkspaceMaterializationSymlinkTarget({
            workspaceRoot: params.targetPath,
            linkPath: targetEntryPath,
            target: entry.target,
        });
    }
}

async function applyDirectoryEntry(params: Readonly<{
    targetPath: string;
    entry: WorkspaceDirectoryEntry;
    rollback?: WorkspaceSyncRollbackState;
}>): Promise<void> {
    const targetEntryPath = resolveTargetWorkspacePath({
        workspaceRoot: params.targetPath,
        relativePath: params.entry.relativePath,
    });
    await ensureWorkspaceParentDirectory({
        workspaceRoot: params.targetPath,
        entryRelativePath: params.entry.relativePath,
        rollback: params.rollback,
    });

    try {
        const stats = await lstat(targetEntryPath);
        if (stats.isDirectory()) {
            return;
        }
        if (params.rollback) {
            await backupWorkspacePathForRollback({
                rollback: params.rollback,
                workspaceRoot: params.targetPath,
                relativePath: params.entry.relativePath,
            });
        }
        await rm(targetEntryPath, { recursive: true, force: true });
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
        if (params.rollback) {
            await backupWorkspacePathForRollback({
                rollback: params.rollback,
                workspaceRoot: params.targetPath,
                relativePath: params.entry.relativePath,
            });
        }
    }

    await mkdir(targetEntryPath, { recursive: true });
}

async function applyFileEntry(params: Readonly<{
    targetPath: string;
    stagingWorkspaceRoot: string;
    entry: WorkspaceFileEntry;
    rollback?: WorkspaceSyncRollbackState;
}>): Promise<void> {
    const targetEntryPath = resolveTargetWorkspacePath({
        workspaceRoot: params.targetPath,
        relativePath: params.entry.relativePath,
    });
    const stagedEntryPath = resolveTargetWorkspacePath({
        workspaceRoot: params.stagingWorkspaceRoot,
        relativePath: params.entry.relativePath,
    });

    await ensureWorkspaceParentDirectory({
        workspaceRoot: params.targetPath,
        entryRelativePath: params.entry.relativePath,
        rollback: params.rollback,
    });
    if (params.rollback) {
        await backupWorkspacePathForRollback({
            rollback: params.rollback,
            workspaceRoot: params.targetPath,
            relativePath: params.entry.relativePath,
        });
    }
    await removeWorkspacePathIfExists(targetEntryPath);
    await copyFile(stagedEntryPath, targetEntryPath);
    await applyWorkspaceMetadata({
        entryKind: 'file',
        entryPath: targetEntryPath,
        mode: params.entry.executable ? 0o755 : 0o644,
    });
}

async function applySymlinkEntry(params: Readonly<{
    targetPath: string;
    entry: WorkspaceSymlinkEntry;
    rollback?: WorkspaceSyncRollbackState;
}>): Promise<void> {
    const targetEntryPath = resolveTargetWorkspacePath({
        workspaceRoot: params.targetPath,
        relativePath: params.entry.relativePath,
    });

    await ensureWorkspaceParentDirectory({
        workspaceRoot: params.targetPath,
        entryRelativePath: params.entry.relativePath,
        rollback: params.rollback,
    });
    if (params.rollback) {
        await backupWorkspacePathForRollback({
            rollback: params.rollback,
            workspaceRoot: params.targetPath,
            relativePath: params.entry.relativePath,
        });
    }
    await removeWorkspacePathIfExists(targetEntryPath);
    await symlink(params.entry.target, targetEntryPath);
}

async function applyChangedWorkspaceEntries(params: Readonly<{
    targetPath: string;
    stagingWorkspaceRoot: string;
    entries: readonly WorkspaceManifestEntry[];
    rollback?: WorkspaceSyncRollbackState;
    assertCanContinue?: () => Promise<void>;
}>): Promise<void> {
    const directoryEntries = params.entries.filter(
        (entry): entry is WorkspaceDirectoryEntry => entry.kind === 'directory',
    );
    const fileEntries = params.entries.filter(
        (entry): entry is WorkspaceFileEntry => entry.kind === 'file',
    );
    const symlinkEntries = params.entries.filter(
        (entry): entry is WorkspaceSymlinkEntry => entry.kind === 'symlink',
    );

    for (const entry of directoryEntries) {
        await params.assertCanContinue?.();
        await applyDirectoryEntry({
            targetPath: params.targetPath,
            entry,
            rollback: params.rollback,
        });
    }

    for (const entry of fileEntries) {
        await params.assertCanContinue?.();
        await applyFileEntry({
            targetPath: params.targetPath,
            stagingWorkspaceRoot: params.stagingWorkspaceRoot,
            entry,
            rollback: params.rollback,
        });
    }

    for (const entry of symlinkEntries) {
        await params.assertCanContinue?.();
        await applySymlinkEntry({
            targetPath: params.targetPath,
            entry,
            rollback: params.rollback,
        });
    }
}

export async function applyWorkspaceSyncArtifacts(params: Readonly<{
    targetPath: string;
    syncArtifacts: WorkspaceSyncArtifacts;
    blobProvider: WorkspaceExportBlobProvider;
    registry?: ScmBackendRegistry;
    assertCanContinue?: () => Promise<void>;
}>): Promise<Readonly<{ targetPath: string }>> {
    const targetWorkspaceRootInitiallyExisted = await (async () => {
        try {
            await lstat(params.targetPath);
            return true;
        } catch (error) {
            if (isMissingPathError(error)) {
                return false;
            }
            throw error;
        }
    })();
    await ensureTargetWorkspaceRoot(params.targetPath);
    await assertPortableWorkspaceEntriesWithSourceController({
        entries: params.syncArtifacts.changedWorkspaceArtifacts.manifest.entries,
        registry: params.registry,
    });
    assertSyncArtifactsStayWithinTarget(params);

    const stagingRoot = await createWorkspaceStagingRoot({
        parentDirectory: dirname(params.targetPath),
        stagingId: `workspace-sync-${randomUUID()}`,
    });

    try {
        const staged = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: params.syncArtifacts.changedWorkspaceArtifacts.manifest,
            blobProvider: params.blobProvider,
            assertCanContinue: params.assertCanContinue,
        });
        if (!staged.verification.isVerified) {
            throw new Error(`Workspace transfer integrity check failed for ${params.targetPath}`);
        }

        const rollback = createWorkspaceSyncRollbackState(join(stagingRoot.rootDirectory, 'rollback'));

        try {
            await params.assertCanContinue?.();
            for (const relativePath of params.syncArtifacts.removedRelativePaths) {
                await params.assertCanContinue?.();
                await backupWorkspacePathForRollback({
                    rollback,
                    workspaceRoot: params.targetPath,
                    relativePath,
                });
                await removeWorkspacePathIfExists(resolveTargetWorkspacePath({
                    workspaceRoot: params.targetPath,
                    relativePath,
                }));
            }

            await applyChangedWorkspaceEntries({
                targetPath: params.targetPath,
                stagingWorkspaceRoot: stagingRoot.workspaceDirectory,
                entries: params.syncArtifacts.changedWorkspaceArtifacts.manifest.entries,
                rollback,
                assertCanContinue: params.assertCanContinue,
            });
            await params.assertCanContinue?.();
        } catch (error) {
            try {
                await rollbackWorkspaceSyncMutations({
                    rollback,
                    workspaceRoot: params.targetPath,
                    targetWorkspaceRootInitiallyExisted,
                });
            } catch (rollbackError) {
                throw new Error(
                    `Workspace sync apply failed for ${params.targetPath} and rollback could not be completed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                    { cause: error },
                );
            }
            throw error;
        }
    } finally {
        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);
    }

    return { targetPath: params.targetPath };
}

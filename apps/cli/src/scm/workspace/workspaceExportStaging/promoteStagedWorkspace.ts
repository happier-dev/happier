import { access, mkdir, rename } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { PinnedUnixDirectoryAccess } from '@/utils/fs/unixPathAccess';

import { resolveWorkspaceRelativePath } from '../workspaceExportPackaging/resolveWorkspaceRelativePath';
import { applyWorkspaceMetadata } from './applyWorkspaceMetadata';
import { readWorkspaceStagingRootMarker, type WorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { verifyStagedWorkspace, type VerifyStagedWorkspaceResult } from './verifyStagedWorkspace';

type WorkspaceFileManifestEntry = Extract<WorkspaceManifest['entries'][number], { kind: 'file' }>;
export type WorkspaceMaterializedEntryAccess = (entry: Readonly<{
    path: string; directory: boolean; pinnedRoot?: PinnedUnixDirectoryAccess;
}>) => Promise<void>;

function resolveWorkspaceEntryPath(params: Readonly<{
    workspaceRoot: string;
    relativePath: string;
}>): string {
    const resolved = resolveWorkspaceRelativePath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: params.relativePath,
    });
    if (!resolved.ok || resolved.relativePath.length === 0) {
        throw new Error(`Workspace promotion entry path escaped the workspace root: ${params.relativePath}`);
    }

    return join(params.workspaceRoot, resolved.relativePath);
}

async function applyPromotedWorkspaceMetadata(params: Readonly<{
    workspaceDirectory: string;
    expectedManifest: WorkspaceManifest;
    prepareEntryAccess?: WorkspaceMaterializedEntryAccess;
    pinnedRoot?: PinnedUnixDirectoryAccess;
}>): Promise<void> {
    for (const entry of params.expectedManifest.entries) {
        if (entry.kind === 'symlink') continue;
        const entryPath = resolveWorkspaceEntryPath({ workspaceRoot: params.workspaceDirectory, relativePath: entry.relativePath });
        if (entry.kind === 'file' && params.pinnedRoot) {
            await params.pinnedRoot.chmod(relative(params.pinnedRoot.path, entryPath), entry.executable ? 0o755 : 0o644);
        } else if (entry.kind === 'file') await applyWorkspaceMetadata({
            entryKind: 'file',
            entryPath,
            mode: entry.executable ? 0o755 : 0o644,
        });
    }
    // Finish every write and metadata effect while the staging root is private.
    // Grants happen only afterwards, and its traversal grant is always last.
    for (const entry of params.expectedManifest.entries) {
        if (entry.kind === 'symlink') continue;
        await params.prepareEntryAccess?.({
            path: resolveWorkspaceEntryPath({ workspaceRoot: params.workspaceDirectory, relativePath: entry.relativePath }),
            directory: entry.kind === 'directory', pinnedRoot: params.pinnedRoot,
        });
    }
    await params.prepareEntryAccess?.({ path: params.workspaceDirectory, directory: true, pinnedRoot: params.pinnedRoot });
}

export type PromoteStagedWorkspaceResult = Readonly<{
    targetWorkspaceDirectory: string;
    verification: VerifyStagedWorkspaceResult;
}>;

async function assertVerifiedStagingRootMarker(stagingRoot: WorkspaceStagingRoot): Promise<void> {
    const marker = await readWorkspaceStagingRootMarker({ rootDirectory: stagingRoot.rootDirectory });

    if (marker.rootDirectory !== stagingRoot.rootDirectory || marker.stagingId !== stagingRoot.stagingId) {
        throw new Error(`Workspace staging root marker does not match descriptor for ${stagingRoot.rootDirectory}`);
    }
}

async function assertTargetWorkspaceDoesNotExist(targetWorkspaceDirectory: string): Promise<void> {
    try {
        await access(targetWorkspaceDirectory);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    throw new Error(`Target workspace root already exists: ${targetWorkspaceDirectory}`);
}

function collectExpectedBlobDigests(expectedManifest: WorkspaceManifest): readonly string[] {
    return [...new Set(expectedManifest.entries
        .filter((entry): entry is WorkspaceFileManifestEntry => entry.kind === 'file')
        .map((entry) => entry.digest))];
}

export async function promoteStagedWorkspace(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    targetWorkspaceDirectory: string;
    expectedManifest: WorkspaceManifest;
    scmRegistry?: ScmBackendRegistry;
    prepareEntryAccess?: WorkspaceMaterializedEntryAccess;
    pinnedRoot?: PinnedUnixDirectoryAccess;
}>): Promise<PromoteStagedWorkspaceResult> {
    await assertVerifiedStagingRootMarker(params.stagingRoot);
    await assertTargetWorkspaceDoesNotExist(params.targetWorkspaceDirectory);

    const verification = await verifyStagedWorkspace({
        workspaceDirectory: params.stagingRoot.workspaceDirectory,
        blobsDirectory: params.stagingRoot.blobsDirectory,
        expectedManifest: params.expectedManifest,
        expectedBlobDigests: collectExpectedBlobDigests(params.expectedManifest),
        scmRegistry: params.scmRegistry,
    });
    if (!verification.isVerified) {
        throw new Error(`Staged workspace verification failed for ${params.stagingRoot.rootDirectory}`);
    }

    await applyPromotedWorkspaceMetadata({
        workspaceDirectory: params.stagingRoot.workspaceDirectory,
        expectedManifest: params.expectedManifest,
        prepareEntryAccess: params.prepareEntryAccess,
        pinnedRoot: params.pinnedRoot,
    });

    await mkdir(dirname(params.targetWorkspaceDirectory), { recursive: true });
    await rename(params.stagingRoot.workspaceDirectory, params.targetWorkspaceDirectory);

    return {
        targetWorkspaceDirectory: params.targetWorkspaceDirectory,
        verification,
    };
}

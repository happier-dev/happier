import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceDirectory, type StagedWorkspaceDirectory } from './stageWorkspaceDirectory';
import { stageWorkspaceFileEntry } from './stageWorkspaceFileEntry';
import type { StagedWorkspaceFileBlob } from './stageWorkspaceFileBlob';
import { stageWorkspaceSymlink, type StagedWorkspaceSymlink } from './stageWorkspaceSymlink';
import { verifyStagedWorkspace, type VerifyStagedWorkspaceResult } from './verifyStagedWorkspace';

type WorkspaceFileManifestEntry = Extract<WorkspaceManifest['entries'][number], { kind: 'file' }>;
type WorkspaceDirectoryManifestEntry = Extract<WorkspaceManifest['entries'][number], { kind: 'directory' }>;
type WorkspaceSymlinkManifestEntry = Extract<WorkspaceManifest['entries'][number], { kind: 'symlink' }>;

export type StageWorkspaceEntriesResult = Readonly<{
    stagedDirectories: readonly StagedWorkspaceDirectory[];
    stagedSymlinks: readonly StagedWorkspaceSymlink[];
    stagedBlobs: readonly StagedWorkspaceFileBlob[];
    verification: VerifyStagedWorkspaceResult;
}>;

export type WorkspaceExportBlobProvider = Readonly<{
    getBlobFilePath: (digest: string) => string | null | undefined;
}>;

export async function stageWorkspaceEntries(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    expectedManifest: WorkspaceManifest;
    blobProvider?: WorkspaceExportBlobProvider;
    assertCanContinue?: () => Promise<void>;
}>): Promise<StageWorkspaceEntriesResult> {
    const fileEntries = params.expectedManifest.entries.filter(
        (entry): entry is WorkspaceFileManifestEntry => entry.kind === 'file',
    );
    const directoryEntries = params.expectedManifest.entries.filter(
        (entry): entry is WorkspaceDirectoryManifestEntry => entry.kind === 'directory',
    );
    const symlinkEntries = params.expectedManifest.entries.filter(
        (entry): entry is WorkspaceSymlinkManifestEntry => entry.kind === 'symlink',
    );
    const uniqueBlobDigests = [...new Set(fileEntries.map((entry) => entry.digest))];
    const blobSourcePathsByDigest = resolveWorkspaceBlobSourcePaths({
        blobProvider: params.blobProvider,
        digests: uniqueBlobDigests,
    });

    const stagedDirectories: StagedWorkspaceDirectory[] = [];
    for (const entry of directoryEntries) {
        await params.assertCanContinue?.();
        stagedDirectories.push(await stageWorkspaceDirectory({
            stagingRoot: params.stagingRoot,
            relativePath: entry.relativePath,
        }));
    }

    const stagedSymlinks: StagedWorkspaceSymlink[] = [];
    for (const entry of symlinkEntries) {
        await params.assertCanContinue?.();
        stagedSymlinks.push(await stageWorkspaceSymlink({
            stagingRoot: params.stagingRoot,
            relativePath: entry.relativePath,
            target: entry.target,
        }));
    }

    const stagedBlobsByDigest = new Map<string, StagedWorkspaceFileBlob>();
    for (const entry of fileEntries) {
        await params.assertCanContinue?.();
        const sourceFilePath = blobSourcePathsByDigest.get(entry.digest);
        if (!sourceFilePath) {
            throw new Error(`Missing staged blob source for digest ${entry.digest}`);
        }

        const stagedFile = await stageWorkspaceFileEntry({
            stagingRoot: params.stagingRoot,
            relativePath: entry.relativePath,
            digest: entry.digest,
            sourceFilePath,
            executable: entry.executable,
        });
        stagedBlobsByDigest.set(stagedFile.blob.digest, stagedFile.blob);
    }
    const stagedBlobs = [...stagedBlobsByDigest.values()];

    const verification = await verifyStagedWorkspace({
        workspaceDirectory: params.stagingRoot.workspaceDirectory,
        blobsDirectory: params.stagingRoot.blobsDirectory,
        expectedManifest: params.expectedManifest,
        expectedBlobDigests: uniqueBlobDigests,
    });

    return {
        stagedDirectories,
        stagedSymlinks,
        stagedBlobs,
        verification,
    };
}

function resolveWorkspaceBlobSourcePaths(params: Readonly<{
    blobProvider?: WorkspaceExportBlobProvider;
    digests: readonly string[];
}>): ReadonlyMap<string, string> {
    if (!params.blobProvider) {
        throw new Error('Workspace staging requires a file-backed blobProvider');
    }

    const blobSourcePaths = new Map<string, string>();

    for (const digest of params.digests) {
        const blobFilePath = params.blobProvider.getBlobFilePath(digest);
        if (blobFilePath !== undefined && blobFilePath !== null) {
            blobSourcePaths.set(digest, blobFilePath);
            continue;
        }
        throw new Error(`Missing staged blob file for digest ${digest}`);
    }

    return blobSourcePaths;
}

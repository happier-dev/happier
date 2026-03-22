import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceDirectory, type StagedWorkspaceDirectory } from './stageWorkspaceDirectory';
import { stageWorkspaceFileEntry, stageWorkspaceFileEntryFromFile } from './stageWorkspaceFileEntry';
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

type WorkspaceBlobSource = Readonly<
    | {
        kind: 'content';
        content: Uint8Array;
    }
    | {
        kind: 'file';
        sourceFilePath: string;
    }
>;

function readRequiredBlobContent(params: Readonly<{
    blobContentsByDigest: ReadonlyMap<string, Uint8Array>;
    digest: string;
}>): Uint8Array {
    const blobContent = params.blobContentsByDigest.get(params.digest);
    if (blobContent !== undefined) {
        return blobContent;
    }

    throw new Error(`Missing staged blob contents for digest ${params.digest}`);
}

export async function stageWorkspaceEntries(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    expectedManifest: WorkspaceManifest;
    blobContentsByDigest?: ReadonlyMap<string, Uint8Array>;
    blobProvider?: WorkspaceExportBlobProvider;
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
    const blobSourcesByDigest = resolveWorkspaceBlobSources({
        blobContentsByDigest: params.blobContentsByDigest,
        blobProvider: params.blobProvider,
        digests: uniqueBlobDigests,
    });

    const stagedDirectories: StagedWorkspaceDirectory[] = [];
    for (const entry of directoryEntries) {
        stagedDirectories.push(await stageWorkspaceDirectory({
            stagingRoot: params.stagingRoot,
            relativePath: entry.relativePath,
        }));
    }

    const stagedSymlinks: StagedWorkspaceSymlink[] = [];
    for (const entry of symlinkEntries) {
        stagedSymlinks.push(await stageWorkspaceSymlink({
            stagingRoot: params.stagingRoot,
            relativePath: entry.relativePath,
            target: entry.target,
        }));
    }

    const stagedBlobsByDigest = new Map<string, StagedWorkspaceFileBlob>();
    for (const entry of fileEntries) {
        const blobSource = blobSourcesByDigest.get(entry.digest);
        if (blobSource === undefined) {
            throw new Error(`Missing staged blob contents for digest ${entry.digest}`);
        }

        const stagedFile = blobSource.kind === 'file'
            ? await stageWorkspaceFileEntryFromFile({
                stagingRoot: params.stagingRoot,
                relativePath: entry.relativePath,
                digest: entry.digest,
                sourceFilePath: blobSource.sourceFilePath,
                executable: entry.executable,
            })
            : await stageWorkspaceFileEntry({
                stagingRoot: params.stagingRoot,
                relativePath: entry.relativePath,
                digest: entry.digest,
                content: blobSource.content,
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

function resolveWorkspaceBlobSources(params: Readonly<{
    blobContentsByDigest?: ReadonlyMap<string, Uint8Array>;
    blobProvider?: WorkspaceExportBlobProvider;
    digests: readonly string[];
}>): ReadonlyMap<string, WorkspaceBlobSource> {
    const blobSources = new Map<string, WorkspaceBlobSource>();

    for (const digest of params.digests) {
        const blobFilePath = params.blobProvider?.getBlobFilePath(digest);
        if (blobFilePath !== undefined && blobFilePath !== null) {
            blobSources.set(digest, {
                kind: 'file',
                sourceFilePath: blobFilePath,
            });
            continue;
        }

        if (params.blobContentsByDigest === undefined) {
            throw new Error(`Missing staged blob contents for digest ${digest}`);
        }

        blobSources.set(digest, {
            kind: 'content',
            content: readRequiredBlobContent({ blobContentsByDigest: params.blobContentsByDigest, digest }),
        });
    }

    return blobSources;
}

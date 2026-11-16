import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceExportBlobProvider } from '../../workspaceExportStaging/stageWorkspaceEntries';

import { buildWorkspaceManifestEntry, type WorkspaceManifestEntry } from '../buildWorkspaceManifestEntry';
import type { WorkspaceExportTransferEntry } from '../workspaceExportTransferEntry';
import { fingerprintWorkspaceManifest } from '../fingerprintWorkspaceManifest';
import { hashWorkspaceFile } from '../hashWorkspaceFile';

export type WorkspaceExportArtifactsWithSourcePathBlobProviderResult = Readonly<{
    manifest: WorkspaceManifest;
    blobProvider: WorkspaceExportBlobProvider;
}>;

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function collectParentDirectories(relativePath: string): readonly string[] {
    const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean);
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function compareManifestEntries(left: WorkspaceManifestEntry, right: WorkspaceManifestEntry): number {
    return left.relativePath.localeCompare(right.relativePath);
}

function createSyntheticDirectoryStats(): Readonly<{
    mode: number;
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}> {
    return {
        mode: 0,
        size: 0,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
    };
}

function buildDirectoryManifestEntry(relativePath: string): Extract<WorkspaceManifestEntry, { kind: 'directory' }> {
    return buildWorkspaceManifestEntry({
        relativePath,
        stats: createSyntheticDirectoryStats(),
    }) as Extract<WorkspaceManifestEntry, { kind: 'directory' }>;
}

async function buildWorkspaceExportManifestEntryWithSourcePath(params: Readonly<{
    entry: WorkspaceExportTransferEntry;
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<Readonly<{
    manifestEntry: Extract<WorkspaceManifestEntry, { kind: 'file' | 'symlink' }>;
    sourcePath?: string;
    disposeSource?: () => Promise<void> | void;
}> | null> {
    let stats;
    try {
        stats = await currentWorkspaceSource().lstat(params.entry.sourcePath);
    } catch (error) {
        if (params.shouldIgnoreAccessError?.(error) === true) {
            return null;
        }
        throw error;
    }

    if (stats.isSymbolicLink()) {
        let target: string;
        try {
            target = await currentWorkspaceSource().readlink(params.entry.sourcePath);
        } catch (error) {
            if (params.shouldIgnoreAccessError?.(error) === true) {
                return null;
            }
            throw error;
        }

        return {
            manifestEntry: buildWorkspaceManifestEntry({
                relativePath: params.entry.relativePath,
                stats,
                symlinkTarget: target,
            }) as Extract<WorkspaceManifestEntry, { kind: 'symlink' }>,
        };
    }

    if (!stats.isFile()) {
        return null;
    }

    const digest = await hashWorkspaceFile({
        filePath: params.entry.sourcePath,
    }).catch((error: unknown) => {
        if (params.shouldIgnoreAccessError?.(error) === true) {
            return null;
        }
        throw error;
    });
    if (!digest) {
        return null;
    }

    return {
        manifestEntry: buildWorkspaceManifestEntry({
            relativePath: params.entry.relativePath,
            stats,
            fileDigest: digest,
        }) as Extract<WorkspaceManifestEntry, { kind: 'file' }>,
        sourcePath: params.entry.sourcePath,
        ...(params.entry.disposeSource ? { disposeSource: params.entry.disposeSource } : {}),
    };
}

export async function buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries(params: Readonly<{
    entries: readonly WorkspaceExportTransferEntry[];
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<WorkspaceExportArtifactsWithSourcePathBlobProviderResult> {
    const manifestEntries = new Map<string, WorkspaceManifestEntry>();
    const blobSourcePathsByDigest = new Map<string, string>();
    const blobSourceDisposersByDigest = new Map<string, () => Promise<void> | void>();
    const disposedDigests = new Set<string>();

    for (const entry of params.entries) {
        const manifestEntryWithSourcePath = await buildWorkspaceExportManifestEntryWithSourcePath({
            entry,
            shouldIgnoreAccessError: params.shouldIgnoreAccessError,
        });
        if (!manifestEntryWithSourcePath) {
            continue;
        }

        for (const directoryPath of collectParentDirectories(manifestEntryWithSourcePath.manifestEntry.relativePath)) {
            manifestEntries.set(directoryPath, buildDirectoryManifestEntry(directoryPath));
        }
        manifestEntries.set(
            manifestEntryWithSourcePath.manifestEntry.relativePath,
            manifestEntryWithSourcePath.manifestEntry,
        );
        if (
            manifestEntryWithSourcePath.manifestEntry.kind === 'file'
            && manifestEntryWithSourcePath.sourcePath
            && !blobSourcePathsByDigest.has(manifestEntryWithSourcePath.manifestEntry.digest)
        ) {
            blobSourcePathsByDigest.set(
                manifestEntryWithSourcePath.manifestEntry.digest,
                manifestEntryWithSourcePath.sourcePath,
            );
            if (manifestEntryWithSourcePath.disposeSource) {
                blobSourceDisposersByDigest.set(
                    manifestEntryWithSourcePath.manifestEntry.digest,
                    manifestEntryWithSourcePath.disposeSource,
                );
            }
        }
    }

    const manifest: WorkspaceManifest = {
        entries: [...manifestEntries.values()].sort(compareManifestEntries),
    };
    manifest.fingerprint = fingerprintWorkspaceManifest({
        entries: manifest.entries,
    });

    return {
        manifest,
        blobProvider: {
            getBlobFilePath: (digest) => blobSourcePathsByDigest.get(digest),
            disposeBlobFilePath: async (digest) => {
                if (disposedDigests.has(digest)) return;
                const dispose = blobSourceDisposersByDigest.get(digest);
                if (!dispose) return;
                disposedDigests.add(digest);
                await dispose();
            },
            dispose: async () => {
                await Promise.all([...blobSourceDisposersByDigest.keys()].map(async (digest) => {
                    if (disposedDigests.has(digest)) return;
                    disposedDigests.add(digest);
                    await blobSourceDisposersByDigest.get(digest)?.();
                }));
            },
        },
    };
}

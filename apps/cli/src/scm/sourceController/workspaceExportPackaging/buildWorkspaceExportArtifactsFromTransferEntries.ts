import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { buildWorkspaceManifestEntry, type WorkspaceManifestEntry } from './buildWorkspaceManifestEntry';
import { fingerprintWorkspaceManifest } from './fingerprintWorkspaceManifest';

export type WorkspaceExportTransferEntry = Readonly<{
    relativePath: string;
    sourcePath: string;
}>;

export type WorkspaceExportArtifacts = Readonly<{
    manifest: WorkspaceManifest;
    blobContentsByDigest: ReadonlyMap<string, Uint8Array>;
}>;

type BuildWorkspaceExportArtifactsFromTransferEntriesResult = Readonly<{
    manifestEntry: Extract<WorkspaceManifestEntry, { kind: 'file' | 'symlink' }>;
    blobContent?: Uint8Array;
}>;

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function createWorkspaceFileDigest(content: Uint8Array): string {
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
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

async function buildWorkspaceExportArtifactEntry(params: Readonly<{
    entry: WorkspaceExportTransferEntry;
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<BuildWorkspaceExportArtifactsFromTransferEntriesResult | null> {
    let stats;
    try {
        stats = await lstat(params.entry.sourcePath);
    } catch (error) {
        if (params.shouldIgnoreAccessError?.(error) === true) {
            return null;
        }
        throw error;
    }

    if (stats.isSymbolicLink()) {
        let target: string;
        try {
            target = await readlink(params.entry.sourcePath);
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

    let content: Buffer;
    try {
        content = await readFile(params.entry.sourcePath);
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
            fileDigest: createWorkspaceFileDigest(content),
        }) as Extract<WorkspaceManifestEntry, { kind: 'file' }>,
        blobContent: content,
    };
}

export async function buildWorkspaceExportArtifactsFromTransferEntries(params: Readonly<{
    entries: readonly WorkspaceExportTransferEntry[];
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<WorkspaceExportArtifacts> {
    const collectedEntries = (await Promise.all(
        params.entries.map(async (entry) => await buildWorkspaceExportArtifactEntry({
            entry,
            shouldIgnoreAccessError: params.shouldIgnoreAccessError,
        })),
    )).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const manifestEntries = new Map<string, WorkspaceManifestEntry>();
    const blobContentsByDigest = new Map<string, Uint8Array>();

    for (const entry of collectedEntries) {
        for (const directoryPath of collectParentDirectories(entry.manifestEntry.relativePath)) {
            manifestEntries.set(directoryPath, buildDirectoryManifestEntry(directoryPath));
        }
        manifestEntries.set(entry.manifestEntry.relativePath, entry.manifestEntry);
        if (entry.manifestEntry.kind === 'file' && entry.blobContent) {
            blobContentsByDigest.set(entry.manifestEntry.digest, entry.blobContent);
        }
    }

    const manifest: WorkspaceManifest = {
        entries: [...manifestEntries.values()].sort(compareManifestEntries),
    };
    manifest.fingerprint = fingerprintWorkspaceManifest({ entries: manifest.entries });

    return {
        manifest,
        blobContentsByDigest,
    };
}

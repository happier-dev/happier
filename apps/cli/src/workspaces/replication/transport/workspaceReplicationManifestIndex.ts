import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces';

import { isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceReplicationManifestDigestIndexEntry = Readonly<{
    relativePath: string;
    sizeBytes: number;
}>;

export function buildWorkspaceReplicationManifestDigestIndex(
    manifest: WorkspaceManifest,
): Map<string, WorkspaceReplicationManifestDigestIndexEntry> {
    const index = new Map<string, WorkspaceReplicationManifestDigestIndexEntry>();
    for (const entry of manifest.entries) {
        if (entry.kind !== 'file') continue;
        if (index.has(entry.digest)) continue;
        index.set(entry.digest, {
            relativePath: entry.relativePath,
            sizeBytes: entry.sizeBytes,
        });
    }
    return index;
}

export function resolveSafeWorkspaceReplicationManifestEntryPath(params: Readonly<{
    workspaceRoot: string;
    relativePath: string;
}>): string {
    // Workspace manifests are expected to contain root-relative paths. Fail closed to avoid path traversal.
    const absolutePath = resolve(params.workspaceRoot, params.relativePath);
    const rel = relative(params.workspaceRoot, absolutePath);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Invalid workspace manifest relativePath: ${params.relativePath}`);
    }
    return absolutePath;
}

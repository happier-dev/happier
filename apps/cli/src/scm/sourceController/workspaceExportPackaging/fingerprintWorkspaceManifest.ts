import { createHash } from 'node:crypto';

import type { WorkspaceManifestEntry } from './buildWorkspaceManifestEntry';

function serializeWorkspaceManifestEntry(entry: WorkspaceManifestEntry): string {
    if (entry.kind === 'directory') {
        return `directory\t${entry.relativePath}`;
    }

    if (entry.kind === 'symlink') {
        return `symlink\t${entry.relativePath}\t${entry.target}`;
    }

    return `file\t${entry.relativePath}\t${entry.digest}\t${entry.sizeBytes}\t${entry.executable ? '1' : '0'}`;
}

export function fingerprintWorkspaceManifest(params: Readonly<{ entries: readonly WorkspaceManifestEntry[] }>): string {
    const hash = createHash('sha256');
    const canonicalEntries = [...params.entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    hash.update('workspace-manifest-v1\n');
    for (const entry of canonicalEntries) {
        hash.update(serializeWorkspaceManifestEntry(entry));
        hash.update('\n');
    }

    return `sha256:${hash.digest('hex')}`;
}

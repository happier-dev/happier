import type { WorkspaceManifest } from '@happier-dev/protocol';

export function assertWorkspaceReplicationDigestsAllowedByManifest(
    manifest: WorkspaceManifest,
    digests: readonly string[],
): void {
    const allowed = new Set<string>();
    for (const entry of manifest.entries) {
        if (entry.kind !== 'file') continue;
        allowed.add(entry.digest);
    }

    for (const digest of digests) {
        if (!allowed.has(digest)) {
            throw new Error(`Workspace replication digest not in manifest: ${digest}`);
        }
    }
}

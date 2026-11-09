import type { PluginUiPersistentArtifactFile } from '@/sync/domains/plugins/ui/artifactByteCache';

import type { PluginArtifactLeasePersistentScope, PluginSelectedArtifactLease } from './artifactLease';

/** Retain verified bytes without keeping a retired acquisition behind physical IO. */
export async function persistVerifiedPluginArtifactLease(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    persistent: PluginArtifactLeasePersistentScope;
}>): Promise<void> {
    const current = () => input.persistent.isCurrent() && input.lease.isCurrent();
    if (!current()) return;
    const files: PluginUiPersistentArtifactFile[] = [];
    for (const declared of input.lease.files) {
        const result = await input.lease.readFile(declared.relativePath);
        if (result.kind !== 'available' || !current()) return;
        files.push(Object.freeze({
            relativePath: result.file.relativePath,
            digest: result.file.digest,
            byteSize: result.file.byteSize,
            bytes: new Uint8Array(result.bytes),
        }));
    }
    const entry = files.find(file => file.relativePath === input.lease.artifactGraph.entry);
    if (!entry || !current()) return;

    let retirement: Readonly<{ dispose(): void }> | undefined;
    const retired = new Promise<void>(resolve => { retirement = input.lease.onRevoke(resolve); });
    try {
        if (!current()) return;
        await Promise.race([
            input.persistent.store.write(Object.freeze({
                persistentIdentity: Object.freeze({
                    accountScope: input.persistent.scope,
                    artifactDigest: input.lease.artifact.digest,
                }),
                bytes: new Uint8Array(entry.bytes),
                entryRelativePath: input.lease.artifactGraph.entry,
                files: Object.freeze(files),
            })),
            retired,
        ]);
    } catch {
        // Optional retention failure does not invalidate the verified bytes.
    } finally {
        retirement?.dispose();
    }
    // The physical custody owner still fences Account writes. A completed
    // write is retained even if this mount retires; retirement never deletes it.
}

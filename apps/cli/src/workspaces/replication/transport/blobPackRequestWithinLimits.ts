type DigestIndexEntryLike = Readonly<{
    sizeBytes: number;
}>;

export function assertWorkspaceReplicationBlobPackRequestWithinLimits(input: Readonly<{
    digestIndex: ReadonlyMap<string, DigestIndexEntryLike>;
    digests: readonly string[];
    blobPackTargetBytes: number;
    blobPackMaxSingleBlobBytes: number;
}>): number {
    let totalBytes = 0;

    for (const digest of input.digests) {
        const entry = input.digestIndex.get(digest);
        if (!entry) {
            throw new Error(`Workspace replication digest not in manifest: ${digest}`);
        }
        if (entry.sizeBytes > input.blobPackMaxSingleBlobBytes) {
            throw new Error(`Workspace replication blob exceeds max single-blob bytes: ${digest}`);
        }
        totalBytes += entry.sizeBytes;
    }

    if (input.digests.length > 1 && totalBytes > input.blobPackTargetBytes) {
        throw new Error('Workspace replication blob pack exceeds target bytes');
    }

    return totalBytes;
}

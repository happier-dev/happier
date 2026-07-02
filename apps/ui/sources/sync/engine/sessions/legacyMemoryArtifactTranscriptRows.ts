const LEGACY_MEMORY_ARTIFACT_KINDS = new Set([
    'session_summary_shard.v1',
    'session_synopsis.v1',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyMemoryArtifactLocalId(localId: string | null | undefined): boolean {
    if (typeof localId !== 'string') return false;
    return localId.startsWith('memory:summary_shard:')
        || localId.startsWith('memory:synopsis:');
}

function readHappierKind(content: unknown): string | null {
    if (!isPlainRecord(content)) return null;
    const meta = content.meta;
    if (!isPlainRecord(meta)) return null;
    const happier = meta.happier;
    if (!isPlainRecord(happier)) return null;
    return typeof happier.kind === 'string' ? happier.kind : null;
}

export function isLegacyMemoryArtifactTranscriptRow(row: Readonly<{
    localId: string | null | undefined;
    content: unknown;
}>): boolean {
    if (isLegacyMemoryArtifactLocalId(row.localId)) return true;
    const kind = readHappierKind(row.content);
    return kind !== null && LEGACY_MEMORY_ARTIFACT_KINDS.has(kind);
}

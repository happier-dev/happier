function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A durable fork request id identifies one logical fork attempt across retries.
 * If its child already recorded valid lineage, keep that admitted cutoff even
 * when a later `latest` retry observes a newer parent head.
 */
export function resolveEstablishedForkLineageCutoff(params: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    parentSessionId: string;
    requestId: string | null;
    fallbackCutoffSeqInclusive: number;
}>): number {
    if (!params.requestId) return params.fallbackCutoffSeqInclusive;

    const forkV1 = params.metadata.forkV1;
    const cutoff = isRecord(forkV1) ? forkV1.parentCutoffSeqInclusive : null;
    if (
        !isRecord(forkV1)
        || forkV1.v !== 1
        || forkV1.parentSessionId !== params.parentSessionId
        || forkV1.requestId !== params.requestId
        || typeof cutoff !== 'number'
        || !Number.isInteger(cutoff)
        || cutoff < 0
    ) {
        return params.fallbackCutoffSeqInclusive;
    }

    return cutoff;
}

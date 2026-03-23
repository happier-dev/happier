type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

export type TurnChangeToolMetadata = Readonly<{
    turnId: string;
    sessionId: string;
    provider: string;
    source: 'provider_native' | 'provider_tool' | 'canonical_diff_tool' | 'canonical_patch_tool' | 'scm_reconciled' | 'inferred';
    confidence: 'exact' | 'strong' | 'best_effort';
    turnStatus: 'completed' | 'aborted' | 'interrupted' | 'unknown';
    seqRange: {
        startSeqInclusive: number;
        endSeqInclusive: number;
    };
}>;

export function readTurnChangeToolMetadata(input: unknown): TurnChangeToolMetadata | null {
    const record = asRecord(input);
    const meta = asRecord(record?._happier) ?? asRecord(record?._happy);
    if (!meta) return null;
    if (meta.sessionChangeScope !== 'turn') return null;
    if (typeof meta.turnId !== 'string' || !meta.turnId.trim()) return null;
    if (typeof meta.sessionId !== 'string' || !meta.sessionId.trim()) return null;
    if (typeof meta.provider !== 'string' || !meta.provider.trim()) return null;
    if (typeof meta.source !== 'string' || !meta.source.trim()) return null;
    if (typeof meta.confidence !== 'string' || !meta.confidence.trim()) return null;
    const seqRange = asRecord(meta.seqRange);
    const startSeqInclusive = typeof seqRange?.startSeqInclusive === 'number' ? seqRange.startSeqInclusive : null;
    const endSeqInclusive = typeof seqRange?.endSeqInclusive === 'number' ? seqRange.endSeqInclusive : null;
    if (startSeqInclusive == null || endSeqInclusive == null) return null;
    return {
        turnId: meta.turnId.trim(),
        sessionId: meta.sessionId.trim(),
        provider: meta.provider.trim(),
        source: meta.source as TurnChangeToolMetadata['source'],
        confidence: meta.confidence as TurnChangeToolMetadata['confidence'],
        turnStatus: typeof meta.turnStatus === 'string' ? meta.turnStatus as TurnChangeToolMetadata['turnStatus'] : 'completed',
        seqRange: {
            startSeqInclusive,
            endSeqInclusive,
        },
    };
}

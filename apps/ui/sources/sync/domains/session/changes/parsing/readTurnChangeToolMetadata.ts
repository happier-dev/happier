type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // Avoid expensive JSON parsing for unrelated tool payloads.
        if (!trimmed.startsWith('{')) return null;
        if (!trimmed.includes('"_happier"') && !trimmed.includes('"_happy"')) return null;
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed as RecordLike;
        } catch {
            return null;
        }
    }
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
    if (!record) return null;

    const meta = asRecord(record._happier) ?? asRecord(record._happy);
    if (meta) {
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

    // Fall back to common provider envelopes that wrap the canonical tool input/result.
    const wrapperKeys: readonly string[] = ['output', 'input', 'payload', 'data', 'result', 'value', 'content'];
    for (const key of wrapperKeys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const nested = readTurnChangeToolMetadata(record[key]);
        if (nested) return nested;
    }

    // Some providers store tool result payloads in a string field (e.g. `tool_use_result`).
    // If that string itself is a JSON envelope containing `_happier`, parse it.
    const toolUseResult = record.tool_use_result;
    if (typeof toolUseResult === 'string') {
        const nested = readTurnChangeToolMetadata(toolUseResult);
        if (nested) return nested;
    }

    return null;
}

export function readTurnChangeToolMetadataFromToolCall(tool: Readonly<{
    input?: unknown;
    result?: unknown;
}>): TurnChangeToolMetadata | null {
    return readTurnChangeToolMetadata(tool.input) ?? readTurnChangeToolMetadata(tool.result);
}

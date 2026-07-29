import type { Metadata } from '../types';

function normalizeUserMessageSeqList(values: readonly unknown[] | null | undefined): number[] {
    const normalized: number[] = [];
    for (const value of values ?? []) {
        if (!Number.isSafeInteger(value) || (value as number) < 0) continue;
        if (normalized.includes(value as number)) continue;
        normalized.push(value as number);
    }
    return normalized.sort((a, b) => a - b);
}

/**
 * Locally consumed user rows: exact user-row seqs completed by the CLI host without provider
 * custody, such as slash commands handled at the prompt-loop chokepoint. This is deliberately not
 * a scalar watermark because local completion does not imply provider acceptance for neighboring
 * rows.
 */
export function readLocallyConsumedUserMessageSeqsV1(
    metadata: Readonly<Record<string, unknown>> | null | undefined,
): number[] {
    const value = metadata?.locallyConsumedUserMessageSeqsV1;
    return Array.isArray(value) ? normalizeUserMessageSeqList(value) : [];
}

export function mergeLocallyConsumedUserMessageSeqsV1(
    metadata: Metadata,
    seqs: readonly number[],
): Readonly<{ changed: boolean; metadata: Metadata }> {
    const incoming = normalizeUserMessageSeqList(seqs);
    if (incoming.length === 0) return { changed: false, metadata };
    const existing = readLocallyConsumedUserMessageSeqsV1(metadata as unknown as Record<string, unknown>);
    const merged = normalizeUserMessageSeqList([...existing, ...incoming]);
    if (merged.length === existing.length && merged.every((seq, index) => seq === existing[index])) {
        return { changed: false, metadata };
    }
    return { changed: true, metadata: { ...metadata, locallyConsumedUserMessageSeqsV1: merged } };
}

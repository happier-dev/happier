import type { Metadata } from '../types';

export type UserMessageDeliveryWatermarkModeV1 = 'queueHandoff' | 'providerAcceptance';

/**
 * Owed-delivery watermark (QA A-F2 / D15b): highest user-row seq that is no longer owed to the
 * runner. Most rows become unowed when handed to the runner's agent loop; provider-native rows
 * written from the terminal transcript become unowed when their local echo proves they already
 * reached provider custody. Resume paths previously synthesized the catch-up cursor from
 * `session.seq`, so user rows committed while the runner was down were never delivered on any
 * resume. The runner persists this watermark in session metadata; daemon attach paths clamp the
 * catch-up cursor to it so owed rows are redelivered (at-least-once, deduped by localId/echo
 * suppression).
 */
export function readDeliveredUserMessageSeqV1(metadata: Readonly<Record<string, unknown>> | null | undefined): number | null {
    const value = metadata?.deliveredUserMessageSeqV1;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function mergeDeliveredUserMessageSeqV1(
    metadata: Metadata,
    seq: number,
): Readonly<{ changed: boolean; metadata: Metadata }> {
    const normalized = Number.isInteger(seq) && seq >= 0 ? seq : null;
    if (normalized === null) return { changed: false, metadata };
    const existing = readDeliveredUserMessageSeqV1(metadata as unknown as Record<string, unknown>);
    if (existing !== null && existing >= normalized) return { changed: false, metadata };
    return { changed: true, metadata: { ...metadata, deliveredUserMessageSeqV1: normalized } };
}

/**
 * Provider-accepted watermark: highest user-row seq for which the active runtime proved provider
 * custody. This intentionally does not fall back to `deliveredUserMessageSeqV1`: legacy delivered
 * watermarks may only prove an agent-queue handoff, and provider-acceptance runtimes must not skip
 * rows unless provider custody was explicitly confirmed.
 */
export function readProviderAcceptedUserMessageSeqV1(metadata: Readonly<Record<string, unknown>> | null | undefined): number | null {
    const value = metadata?.providerAcceptedUserMessageSeqV1;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function mergeProviderAcceptedUserMessageSeqV1(
    metadata: Metadata,
    seq: number,
): Readonly<{ changed: boolean; metadata: Metadata }> {
    const normalized = Number.isInteger(seq) && seq >= 0 ? seq : null;
    if (normalized === null) return { changed: false, metadata };
    const existing = readProviderAcceptedUserMessageSeqV1(metadata as unknown as Record<string, unknown>);
    if (existing !== null && existing >= normalized) return { changed: false, metadata };
    return { changed: true, metadata: { ...metadata, providerAcceptedUserMessageSeqV1: normalized } };
}

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

export function readUserMessageDeliveryWatermarkModeV1(
    metadata: Readonly<Record<string, unknown>> | null | undefined,
): UserMessageDeliveryWatermarkModeV1 | null {
    const value = metadata?.userMessageDeliveryWatermarkModeV1;
    return value === 'queueHandoff' || value === 'providerAcceptance' ? value : null;
}

export function mergeUserMessageDeliveryWatermarkModeV1(
    metadata: Metadata,
    mode: UserMessageDeliveryWatermarkModeV1,
): Readonly<{ changed: boolean; metadata: Metadata }> {
    const existing = readUserMessageDeliveryWatermarkModeV1(metadata as unknown as Record<string, unknown>);
    if (existing === mode) return { changed: false, metadata };
    return { changed: true, metadata: { ...metadata, userMessageDeliveryWatermarkModeV1: mode } };
}

export function clampAttachCursorToDeliveredUserMessageSeq(
    cursor: number | undefined,
    deliveredUserMessageSeq: number | null,
): number | undefined {
    if (cursor === undefined || deliveredUserMessageSeq === null) return cursor;
    return Math.min(cursor, deliveredUserMessageSeq);
}

export function resolveAttachCursorForUserMessageDeliveryWatermark(params: Readonly<{
    cursor: number | undefined;
    mode: UserMessageDeliveryWatermarkModeV1;
    deliveredUserMessageSeq: number | null;
    providerAcceptedUserMessageSeq: number | null;
}>): Readonly<{ cursor: number | undefined; effectiveWatermarkSeq: number | null }> {
    if (params.cursor === undefined) {
        return { cursor: undefined, effectiveWatermarkSeq: null };
    }

    if (params.mode === 'providerAcceptance') {
        const effectiveWatermarkSeq = params.providerAcceptedUserMessageSeq ?? 0;
        return {
            cursor: Math.min(params.cursor, effectiveWatermarkSeq),
            effectiveWatermarkSeq,
        };
    }

    return {
        cursor: clampAttachCursorToDeliveredUserMessageSeq(params.cursor, params.deliveredUserMessageSeq),
        effectiveWatermarkSeq: params.deliveredUserMessageSeq,
    };
}

import type { RawRecord } from '@/sync/typesRaw';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';

/**
 * Per-segment assembly state for delta-based live transcript streaming.
 *
 * The CLI streams `transcript-stream-segment-delta` ticks carrying only appended text, plus
 * periodic full `transcript-stream-segment` snapshots as checkpoints. This module owns the
 * receiver-side accumulated text so a delta tick only needs to decrypt/normalize its own few
 * characters instead of the whole segment.
 *
 * Correctness over liveness: any gap (unknown segment, tick gap, base-length mismatch) drops the
 * delta and marks the segment desynced until the next full snapshot resyncs it.
 *
 * Bounded: a small LRU capped at MAX_TRACKED_SEGMENTS; entries are evicted when a snapshot reports
 * the segment complete/interrupted.
 */
const MAX_TRACKED_SEGMENTS = 32;

type TranscriptStreamSegmentAssemblyEntry = {
    text: string;
    lastTick: number | null;
    desynced: boolean;
};

// Map iteration order is insertion order; re-inserting on touch turns it into an LRU.
const assemblyBySegment = new Map<string, TranscriptStreamSegmentAssemblyEntry>();

function buildSegmentKey(sessionId: string, localId: string): string {
    return `${sessionId}\u0000${localId}`;
}

function touchSegment(key: string, entry: TranscriptStreamSegmentAssemblyEntry): void {
    assemblyBySegment.delete(key);
    assemblyBySegment.set(key, entry);
    while (assemblyBySegment.size > MAX_TRACKED_SEGMENTS) {
        const oldestKey = assemblyBySegment.keys().next().value;
        if (oldestKey === undefined) break;
        assemblyBySegment.delete(oldestKey);
    }
}

type SegmentTextRecord = {
    content: {
        type: 'acp';
        data: Record<string, unknown>;
    } & Record<string, unknown>;
} & Record<string, unknown>;

function readAcpSegmentData(record: RawRecord | null): { record: SegmentTextRecord; textField: 'message' | 'text' } | null {
    if (!record || typeof record !== 'object') return null;
    const candidate = record as unknown as Record<string, unknown>;
    if (candidate.role !== 'agent') return null;
    const content = candidate.content;
    if (!content || typeof content !== 'object') return null;
    const contentRecord = content as Record<string, unknown>;
    if (contentRecord.type !== 'acp') return null;
    const data = contentRecord.data;
    if (!data || typeof data !== 'object') return null;
    const dataRecord = data as Record<string, unknown>;
    if (dataRecord.type === 'message' && typeof dataRecord.message === 'string') {
        return { record: candidate as SegmentTextRecord, textField: 'message' };
    }
    if (dataRecord.type === 'thinking' && typeof dataRecord.text === 'string') {
        return { record: candidate as SegmentTextRecord, textField: 'text' };
    }
    return null;
}

/** Extract the streamed segment text from a decrypted live-stream record, or null when not a text segment. */
export function readTranscriptStreamSegmentText(record: RawRecord | null): string | null {
    const acp = readAcpSegmentData(record);
    if (!acp) return null;
    const value = acp.record.content.data[acp.textField];
    return typeof value === 'string' ? value : null;
}

/** Return a copy of the record with the streamed segment text replaced (used to feed the canonical normalize path). */
export function withTranscriptStreamSegmentText(record: RawRecord, text: string): RawRecord | null {
    const acp = readAcpSegmentData(record);
    if (!acp) return null;
    return {
        ...acp.record,
        content: {
            ...acp.record.content,
            data: {
                ...acp.record.content.data,
                [acp.textField]: text,
            },
        },
    } as unknown as RawRecord;
}

/**
 * Record a full-snapshot checkpoint. Establishes/resyncs assembly state, or evicts it when the
 * snapshot reports a terminal segment state or a non-text segment (nothing to chain).
 */
export function noteTranscriptStreamSegmentSnapshot(params: Readonly<{
    sessionId: string;
    localId: string;
    record: RawRecord | null;
    tick: number | null;
}>): void {
    const key = buildSegmentKey(params.sessionId, params.localId);
    const meta = params.record && typeof params.record === 'object'
        ? readStreamSegmentMetaV1((params.record as unknown as Record<string, unknown>).meta)
        : null;
    if (meta?.segmentState === 'complete' || meta?.segmentState === 'interrupted') {
        assemblyBySegment.delete(key);
        return;
    }
    const text = readTranscriptStreamSegmentText(params.record);
    if (text === null) {
        assemblyBySegment.delete(key);
        return;
    }
    touchSegment(key, {
        text,
        lastTick: typeof params.tick === 'number' && Number.isFinite(params.tick) ? Math.trunc(params.tick) : null,
        desynced: false,
    });
}

/** Whether a delta for this segment could currently be chained (used to skip decryption early). */
export function isTranscriptStreamSegmentAssemblyReady(sessionId: string, localId: string): boolean {
    const entry = assemblyBySegment.get(buildSegmentKey(sessionId, localId));
    return entry !== undefined && !entry.desynced;
}

/**
 * Chain a delta onto the assembled text. Returns the new accumulated text, or null when the delta
 * must be dropped (unknown segment, desynced, tick gap, or base-length mismatch). Dropping marks
 * the segment desynced until the next snapshot.
 */
export function applyTranscriptStreamSegmentDelta(params: Readonly<{
    sessionId: string;
    localId: string;
    deltaText: string;
    tick: number;
    baseLength: number;
}>): string | null {
    const key = buildSegmentKey(params.sessionId, params.localId);
    const entry = assemblyBySegment.get(key);
    if (!entry || entry.desynced) {
        if (entry) entry.desynced = true;
        return null;
    }
    const tickChains = entry.lastTick === null || params.tick === entry.lastTick + 1;
    if (!tickChains || entry.text.length !== params.baseLength) {
        entry.desynced = true;
        return null;
    }
    entry.text += params.deltaText;
    entry.lastTick = params.tick;
    touchSegment(key, entry);
    return entry.text;
}

export function evictTranscriptStreamSegmentAssembly(sessionId: string, localId: string): void {
    assemblyBySegment.delete(buildSegmentKey(sessionId, localId));
}

/**
 * Release every tracked segment of a session (bounded transcript retention eviction).
 *
 * The LRU cap bounds entry COUNT, not lifetime: under low segment traffic an evicted
 * session's accumulated text would otherwise stay rooted indefinitely. Releasing is
 * always safe — a later delta for an unknown segment is dropped (desync semantics) and
 * the next full snapshot re-establishes assembly state.
 */
export function releaseTranscriptStreamSegmentAssemblyForSession(sessionId: string): void {
    const prefix = buildSegmentKey(sessionId, '');
    for (const key of Array.from(assemblyBySegment.keys())) {
        if (key.startsWith(prefix)) {
            assemblyBySegment.delete(key);
        }
    }
}

export function resetTranscriptStreamSegmentAssemblyForTests(): void {
    assemblyBySegment.clear();
}

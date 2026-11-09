import type { RawRecord } from '../raw/schemas.js';
import { readStreamSegmentMetaV1 } from "../reducer/helpers/streamSegmentMeta.js";
import {
    SESSION_STREAM_APPEND_BINDING_META_KEY,
    SessionMessageStreamAppendBindingV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';

/**
 * Per-segment text state for one transcript consumer, fed by both streams of a streamed segment.
 *
 * The CLI sends a full `transcript-stream-segment` snapshot when a segment opens or is rewritten,
 * then `transcript-stream-segment-delta` ticks carrying only appended text. Durable revisions of
 * the same row (same localId) arrive as full rows or as appends against a revision the consumer
 * holds. This module owns the consumer's text for both, so neither stream resends the message.
 *
 * Correctness over liveness: a live delta that does not chain (unknown segment, tick gap,
 * base-length mismatch) is buffered with the deltas that follow it; the segment resynchronizes
 * exactly once a durable revision of the same rewrite generation covers the start of that buffer
 * (within one generation the text is append-only, so the durable prefix equals the live prefix).
 * A durable append applies only onto the exact held base revision (`updatedAt` and length) and
 * only when its sealed binding names this message, that base and the result; otherwise the caller
 * reads the full message.
 *
 * Entries live until their segment completes/is interrupted or their consumer releases the session.
 */

type TranscriptStreamSegmentAssemblyEntry = {
    /** Live text, or null while the live chain is broken. */
    text: string | null;
    /** Rewrite generation of `text`; text of another generation is never chained onto it. */
    generation: number;
    lastTick: number | null;
    /** Contiguous live deltas received while the chain was broken. */
    pending: { start: number; text: string; lastTick: number; generation: number } | null;
    /** The durable revision whose body this consumer holds. */
    durable: { messageId: string; updatedAt: number; text: string; generation: number } | null;
};

function buildSegmentKey(sessionId: string, localId: string): string {
    return `${sessionId}\u0000${localId}`;
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

/** A decrypted segment record's rewrite generation (absent: 0). */
export function readTranscriptStreamSegmentGeneration(record: RawRecord | null): number {
    const meta = record && typeof record === 'object'
        ? readStreamSegmentMetaV1((record as unknown as Record<string, unknown>).meta)
        : null;
    return meta?.textGeneration ?? 0;
}

/** Whether a decrypted segment record carries a terminal segment state. */
export function isTerminalTranscriptStreamSegmentRecord(record: RawRecord | null): boolean {
    const meta = record && typeof record === 'object'
        ? readStreamSegmentMetaV1((record as unknown as Record<string, unknown>).meta)
        : null;
    return meta?.segmentState === 'complete' || meta?.segmentState === 'interrupted';
}

/** Create independent live delta-chain state for one transcript consumer. */
export function createTranscriptStreamSegmentAssembler() {
    const assemblyBySegment = new Map<string, TranscriptStreamSegmentAssemblyEntry>();

    function readOrCreate(key: string): TranscriptStreamSegmentAssemblyEntry {
        const existing = assemblyBySegment.get(key);
        if (existing) return existing;
        const created: TranscriptStreamSegmentAssemblyEntry = { text: null, generation: 0, lastTick: null, pending: null, durable: null };
        assemblyBySegment.set(key, created);
        return created;
    }

    /** Rejoin a broken live chain from the held durable text once it covers the buffered start. */
    function resync(entry: TranscriptStreamSegmentAssemblyEntry): string | null {
        if (entry.text !== null) return entry.text;
        const { durable, pending } = entry;
        if (!durable || !pending || durable.generation !== pending.generation || durable.text.length < pending.start) return null;
        const spliced = durable.text.slice(0, pending.start) + pending.text;
        entry.generation = durable.generation;
        if (spliced.length >= durable.text.length) {
            entry.text = spliced;
            entry.lastTick = pending.lastTick;
        } else {
            // The durable revision is ahead of every buffered delta: continue from it and accept
            // the next delta that overlaps its end.
            entry.text = durable.text;
            entry.lastTick = null;
        }
        entry.pending = null;
        return entry.text;
    }

    /** Resynchronize from a snapshot, or release a terminal/non-text segment. */
    function noteTranscriptStreamSegmentSnapshot(params: Readonly<{
        sessionId: string;
        localId: string;
        record: RawRecord | null;
        tick: number | null;
    }>): void {
        const key = buildSegmentKey(params.sessionId, params.localId);
        if (isTerminalTranscriptStreamSegmentRecord(params.record)) {
            endTranscriptStreamSegmentLive(params.sessionId, params.localId);
            return;
        }
        const text = readTranscriptStreamSegmentText(params.record);
        if (text === null) {
            assemblyBySegment.delete(key);
            return;
        }
        const entry = readOrCreate(key);
        entry.text = text;
        entry.generation = readTranscriptStreamSegmentGeneration(params.record);
        entry.lastTick = typeof params.tick === 'number' && Number.isFinite(params.tick) ? Math.trunc(params.tick) : null;
        entry.pending = null;
    }

    /** Whether the segment's live chain is intact (a delta would extend it directly). */
    function isTranscriptStreamSegmentAssemblyReady(sessionId: string, localId: string): boolean {
        const entry = assemblyBySegment.get(buildSegmentKey(sessionId, localId));
        return entry !== undefined && entry.text !== null;
    }

    /**
     * Chain a live delta onto the assembled text. Returns the new accumulated text, or null while
     * the chain is broken; a broken chain buffers the delta and rejoins from the durable revision.
     */
    function applyTranscriptStreamSegmentDelta(params: Readonly<{
        sessionId: string;
        localId: string;
        deltaText: string;
        tick: number;
        baseLength: number;
        /** The delta's rewrite generation (absent: 0). */
        generation?: number;
    }>): string | null {
        const generation = params.generation ?? 0;
        const entry = readOrCreate(buildSegmentKey(params.sessionId, params.localId));
        if (entry.text !== null && entry.generation !== generation) entry.text = null;
        if (entry.text !== null) {
            const text = entry.text;
            if (entry.lastTick === null) {
                // Continuing from a snapshot without a tick or from a durable revision: the delta
                // must start at or before the end of the held text and reach past it.
                if (params.baseLength <= text.length && params.baseLength + params.deltaText.length >= text.length) {
                    entry.text = text.slice(0, params.baseLength) + params.deltaText;
                    entry.lastTick = params.tick;
                    return entry.text;
                }
            } else if (params.tick === entry.lastTick + 1 && params.baseLength === text.length) {
                entry.text = text + params.deltaText;
                entry.lastTick = params.tick;
                return entry.text;
            }
            entry.text = null;
        }
        const pending = entry.pending;
        if (pending && pending.generation === generation && params.tick === pending.lastTick + 1
            && params.baseLength === pending.start + pending.text.length) {
            pending.text += params.deltaText;
            pending.lastTick = params.tick;
        } else {
            entry.pending = { start: params.baseLength, text: params.deltaText, lastTick: params.tick, generation };
        }
        return resync(entry);
    }

    /**
     * Record the body of a durable revision this consumer applied (a full row or a rebuilt
     * append). A terminal revision releases the segment.
     */
    function noteTranscriptStreamSegmentDurableRevision(params: Readonly<{
        sessionId: string;
        localId: string;
        messageId: string;
        updatedAt: number;
        record: RawRecord | null;
    }>): void {
        const key = buildSegmentKey(params.sessionId, params.localId);
        if (isTerminalTranscriptStreamSegmentRecord(params.record)) {
            assemblyBySegment.delete(key);
            return;
        }
        const meta = params.record && typeof params.record === 'object'
            ? readStreamSegmentMetaV1((params.record as unknown as Record<string, unknown>).meta)
            : null;
        const text = meta?.segmentState === 'streaming' ? readTranscriptStreamSegmentText(params.record) : null;
        if (text === null) {
            const entry = assemblyBySegment.get(key);
            if (entry) entry.durable = null;
            return;
        }
        const entry = readOrCreate(key);
        if (entry.durable && entry.durable.messageId === params.messageId && entry.durable.updatedAt > params.updatedAt) return;
        entry.durable = { messageId: params.messageId, updatedAt: params.updatedAt, text, generation: meta?.textGeneration ?? 0 };
        resync(entry);
    }

    /** Whether this consumer holds exactly the base revision a durable append names. */
    function holdsTranscriptStreamSegmentDurableBase(params: Readonly<{
        sessionId: string;
        localId: string;
        messageId: string;
        base: Readonly<{ updatedAt: number; length: number }>;
    }>): boolean {
        const durable = assemblyBySegment.get(buildSegmentKey(params.sessionId, params.localId))?.durable;
        return durable !== null && durable !== undefined
            && durable.messageId === params.messageId
            && durable.updatedAt === params.base.updatedAt
            && durable.text.length === params.base.length;
    }

    /**
     * Rebuild a durable revision from the held base and a producer append (`record` carries only
     * the appended text). Returns the full record, or null when the exact base is not held.
     */
    function applyTranscriptStreamSegmentDurableAppend(params: Readonly<{
        sessionId: string;
        localId: string;
        messageId: string;
        base: Readonly<{ updatedAt: number; length: number }>;
        updatedAt: number;
        record: RawRecord | null;
    }>): RawRecord | null {
        if (!holdsTranscriptStreamSegmentDurableBase(params)) return null;
        const appended = readTranscriptStreamSegmentText(params.record);
        const durable = assemblyBySegment.get(buildSegmentKey(params.sessionId, params.localId))!.durable!;
        // Home chooses the base it relays against; only the sealed binding proves this fragment
        // was written for this message, this base and this result, in this rewrite generation.
        const meta = params.record && typeof params.record === 'object'
            ? (params.record as unknown as { meta?: Record<string, unknown> }).meta
            : undefined;
        const binding = SessionMessageStreamAppendBindingV1Schema.safeParse(meta?.[SESSION_STREAM_APPEND_BINDING_META_KEY]);
        if (appended === null || !binding.success || binding.data.localId !== params.localId
            || binding.data.baseLength !== durable.text.length
            || binding.data.length !== durable.text.length + appended.length
            || readTranscriptStreamSegmentGeneration(params.record) !== durable.generation) return null;
        const { [SESSION_STREAM_APPEND_BINDING_META_KEY]: _binding, ...recordMeta } = meta ?? {};
        const rebuilt = params.record
            ? withTranscriptStreamSegmentText({ ...(params.record as object), meta: recordMeta } as unknown as RawRecord, durable.text + appended)
            : null;
        if (!rebuilt) return null;
        noteTranscriptStreamSegmentDurableRevision({ ...params, record: rebuilt });
        return rebuilt;
    }

    /** A terminal live frame ends the live chain; the durable base stays for the terminal revision. */
    function endTranscriptStreamSegmentLive(sessionId: string, localId: string): void {
        const key = buildSegmentKey(sessionId, localId);
        const entry = assemblyBySegment.get(key);
        if (!entry) return;
        if (!entry.durable) {
            assemblyBySegment.delete(key);
            return;
        }
        entry.text = null;
        entry.pending = null;
        entry.lastTick = null;
    }

    function evictTranscriptStreamSegmentAssembly(sessionId: string, localId: string): void {
        assemblyBySegment.delete(buildSegmentKey(sessionId, localId));
    }

    /**
     * Release every tracked segment of a session (bounded transcript retention eviction).
     *
     * Without release, an evicted session's accumulated text would remain rooted. Later frames
     * for a released segment start a new entry and rejoin from the next snapshot or durable
     * revision.
     */
    function releaseTranscriptStreamSegmentAssemblyForSession(sessionId: string): void {
        const prefix = buildSegmentKey(sessionId, '');
        for (const key of Array.from(assemblyBySegment.keys())) {
            if (key.startsWith(prefix)) {
                assemblyBySegment.delete(key);
            }
        }
    }

    return {
        noteTranscriptStreamSegmentSnapshot,
        isTranscriptStreamSegmentAssemblyReady,
        applyTranscriptStreamSegmentDelta,
        noteTranscriptStreamSegmentDurableRevision,
        holdsTranscriptStreamSegmentDurableBase,
        applyTranscriptStreamSegmentDurableAppend,
        endTranscriptStreamSegmentLive,
        evictTranscriptStreamSegmentAssembly,
        releaseTranscriptStreamSegmentAssemblyForSession,
    };
}

export type TranscriptStreamSegmentAssembler = ReturnType<typeof createTranscriptStreamSegmentAssembler>;

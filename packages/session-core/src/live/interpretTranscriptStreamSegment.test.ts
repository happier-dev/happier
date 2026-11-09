import { describe, expect, it } from 'vitest';
import {
    createRawMessageNormalizationSequenceState, normalizeRawMessageInSequence,
    createReducer, reducer, applyReducedMessages, createTranscriptStreamSegmentAssembler,
    interpretTranscriptStreamSegment, type NormalizedMessage, type RawRecord, type OrderedTranscript,
} from '../index.js';

function record(text: string, updatedAtMs = 1_010, state: 'streaming' | 'complete' = 'streaming'): RawRecord {
    return {
        role: 'agent',
        content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: text } },
        meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'segment', segmentState: state, startedAtMs: 1_000, updatedAtMs } },
    };
}

function bound(value: RawRecord, binding: Readonly<{ localId: string; baseLength: number; length: number }>): RawRecord {
    const withMeta = value as unknown as { meta: Record<string, unknown> };
    return { ...withMeta, meta: { ...withMeta.meta, happierStreamAppendV1: { v: 1, ...binding } } } as unknown as RawRecord;
}

describe('live interpretation', () => {
    it('converges snapshot, chained delta and durable delivery into one canonical row', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const rawMessageNormalizationState = createRawMessageNormalizationSequenceState();
        const state = createReducer();
        let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        const feed = (normalized: NormalizedMessage | null) => {
            expect(normalized).not.toBeNull();
            if (normalized) transcript = applyReducedMessages(transcript, reducer(state, [normalized], null).messages);
        };
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 }, rawMessageNormalizationState };
        feed(interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 1, record: record('Hello') }));
        const firstId = transcript.messageIdsOldestFirst[0];
        feed(interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 2, baseLength: 5, record: record(' world', 1_040) }));
        const durable = normalizeRawMessageInSequence({ id: 'stored-message', localId: 'segment', createdAt: 1_000, seq: 7, raw: record('Hello world', 1_050, 'complete') }, rawMessageNormalizationState);
        feed(durable);
        expect(transcript.messageIdsOldestFirst).toEqual([firstId]);
        expect(Object.keys(transcript.messagesById)).toHaveLength(1);
        const message = transcript.messagesById[firstId!];
        expect(message?.kind === 'agent-text' && message.text).toBe('Hello world');
        expect(message?.seq).toBe(7);
        const beforeReplay = transcript;
        if (durable) transcript = applyReducedMessages(transcript, reducer(state, [durable], null).messages);
        expect(transcript).toBe(beforeReplay);
    });

    it('drops unknown, tick-gap and mismatched-length deltas until a snapshot resynchronizes', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 } };
        const delta = (tick: number, baseLength: number) => interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick, baseLength, record: record('!') });
        expect(delta(2, 5)).toBeNull();
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 1, record: record('Hello') });
        expect(delta(3, 5)).toBeNull();
        expect(delta(2, 5)).toBeNull();
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 4, record: record('Hello') });
        expect(delta(5, 4)).toBeNull();
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 6, record: record('Hello') });
        const normalized = delta(7, 5);
        expect(normalized?.role === 'agent' && normalized.content[0]?.type === 'text' && normalized.content[0].text).toBe('Hello!');
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 8, record: record('Hello!', 1_050, 'complete') });
        expect(delta(9, 6)).toBeNull();
    });

    it('rejoins a broken live chain exactly from the durable revision, without a full snapshot', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 } };
        const text = (normalized: NormalizedMessage | null) => normalized?.role === 'agent' && normalized.content[0]?.type === 'text' ? normalized.content[0].text : null;
        const delta = (tick: number, baseLength: number, appended: string) => interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick, baseLength, record: record(appended) });
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 1, record: record('ab') });
        expect(text(delta(2, 2, 'cd'))).toBe('abcd');
        // Tick 3 ('ef') is lost; the following deltas are buffered, not guessed at.
        expect(delta(4, 6, 'gh')).toBeNull();
        expect(delta(5, 8, 'ij')).toBeNull();
        // The durable revision covers the buffer's start: the live text rejoins exactly.
        assembler.noteTranscriptStreamSegmentDurableRevision({ sessionId: 'session', localId: 'segment', messageId: 'stored', updatedAt: 2_000, record: record('abcdefg') });
        expect(text(delta(6, 10, 'kl'))).toBe('abcdefghijkl');
        // A late joiner with only a durable revision ahead of the live stream continues from it.
        const late = createTranscriptStreamSegmentAssembler();
        late.noteTranscriptStreamSegmentDurableRevision({ sessionId: 'session', localId: 'segment', messageId: 'stored', updatedAt: 2_000, record: record('abcdefghij') });
        expect(text(interpretTranscriptStreamSegment({ ...base, assembler: late, type: 'transcript-stream-segment-delta', tick: 6, baseLength: 10, record: record('kl') }))).toBe('abcdefghijkl');
    });

    it('rebuilds a durable revision from an append only on the exact held base', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const address = { sessionId: 'session', localId: 'segment', messageId: 'stored' };
        assembler.noteTranscriptStreamSegmentDurableRevision({ ...address, updatedAt: 2_000, record: record('Hello') });
        expect(assembler.applyTranscriptStreamSegmentDurableAppend({ ...address, base: { updatedAt: 1_999, length: 5 }, updatedAt: 4_000, record: record(' world') })).toBeNull();
        expect(assembler.applyTranscriptStreamSegmentDurableAppend({ ...address, base: { updatedAt: 2_000, length: 4 }, updatedAt: 4_000, record: record(' world') })).toBeNull();
        const rebuilt = assembler.applyTranscriptStreamSegmentDurableAppend({ ...address, base: { updatedAt: 2_000, length: 5 }, updatedAt: 4_000, record: bound(record(' world'), { localId: 'segment', baseLength: 5, length: 11 }) });
        expect((rebuilt?.content as { data: { message: string } } | undefined)?.data.message).toBe('Hello world');
        expect(assembler.holdsTranscriptStreamSegmentDurableBase({ ...address, base: { updatedAt: 4_000, length: 11 } })).toBe(true);
    });

    it('never splices a pre-rewrite durable revision onto post-rewrite deltas (missed rewrite snapshot)', () => {
        const generationRecord = (text: string, textGeneration: number) => {
            const value = record(text) as unknown as { meta: { happierStreamSegmentV1: Record<string, unknown> } };
            value.meta.happierStreamSegmentV1.textGeneration = textGeneration;
            return value as unknown as RawRecord;
        };
        const assembler = createTranscriptStreamSegmentAssembler();
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 } };
        const text = (normalized: NormalizedMessage | null) => normalized?.role === 'agent' && normalized.content[0]?.type === 'text' ? normalized.content[0].text : null;
        assembler.noteTranscriptStreamSegmentDurableRevision({ sessionId: 'session', localId: 'segment', messageId: 'stored', updatedAt: 100, record: generationRecord('The answer is 42 because of X.', 0) });
        // The rewrite snapshot ("The answer: 41", generation 1) was missed; its deltas follow.
        expect(interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 8, baseLength: 14, record: generationRecord(' and more', 1) })).toBeNull();
        expect(interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 9, baseLength: 23, record: generationRecord(' still', 1) })).toBeNull();
        // The first durable revision of the rewritten generation rejoins exactly.
        assembler.noteTranscriptStreamSegmentDurableRevision({ sessionId: 'session', localId: 'segment', messageId: 'stored', updatedAt: 200, record: generationRecord('The answer: 41', 1) });
        expect(text(interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 10, baseLength: 29, record: generationRecord('!', 1) }))).toBe('The answer: 41 and more still!');
    });

    it('keeps the durable base through a terminal live frame so the terminal durable append applies (CLI order)', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 } };
        const address = { sessionId: 'session', localId: 'segment', messageId: 'stored' };
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', tick: 1, record: record('Hello') });
        assembler.noteTranscriptStreamSegmentDurableRevision({ ...address, updatedAt: 100, record: record('Hello') });
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 2, baseLength: 5, record: record(' world', 1_050, 'complete') });
        expect(assembler.holdsTranscriptStreamSegmentDurableBase({ ...address, base: { updatedAt: 100, length: 5 } })).toBe(true);
        const rebuilt = assembler.applyTranscriptStreamSegmentDurableAppend({ ...address, base: { updatedAt: 100, length: 5 }, updatedAt: 200,
            record: bound(record(' world', 1_050, 'complete'), { localId: 'segment', baseLength: 5, length: 11 }) });
        expect((rebuilt?.content as { data: { message: string } } | undefined)?.data.message).toBe('Hello world');
        // The terminal durable revision releases the segment.
        expect(assembler.holdsTranscriptStreamSegmentDurableBase({ ...address, base: { updatedAt: 200, length: 11 } })).toBe(false);
    });

    it('rebuilds only when the sealed append binding names this message, base and result', () => {
        const address = { sessionId: 'session', localId: 'segment', messageId: 'stored' };
        const attempt = (append: RawRecord) => {
            const assembler = createTranscriptStreamSegmentAssembler();
            assembler.noteTranscriptStreamSegmentDurableRevision({ ...address, updatedAt: 100, record: record('Hello') });
            return assembler.applyTranscriptStreamSegmentDurableAppend({ ...address, base: { updatedAt: 100, length: 5 }, updatedAt: 200, record: append });
        };
        expect(attempt(record(' world'))).toBeNull();
        expect(attempt(bound(record(' world'), { localId: 'other-segment', baseLength: 5, length: 11 }))).toBeNull();
        expect(attempt(bound(record(' world'), { localId: 'segment', baseLength: 4, length: 11 }))).toBeNull();
        expect(attempt(bound(record(' world'), { localId: 'segment', baseLength: 5, length: 12 }))).toBeNull();
        const rebuilt = attempt(bound(record(' world'), { localId: 'segment', baseLength: 5, length: 11 }));
        expect((rebuilt?.content as { data: { message: string } } | undefined)?.data.message).toBe('Hello world');
        expect((rebuilt as unknown as { meta: Record<string, unknown> }).meta.happierStreamAppendV1).toBeUndefined();
    });

    it('chains the first delta by length when a supported server omitted the snapshot tick', () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const base = { assembler, sessionId: 'session', message: { localId: 'segment', createdAt: 1_000 } };
        interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment', record: record('Hello') });
        const normalized = interpretTranscriptStreamSegment({ ...base, type: 'transcript-stream-segment-delta', tick: 9, baseLength: 5, record: record(' world') });
        expect(normalized?.role === 'agent' && normalized.content[0]?.type === 'text' && normalized.content[0].text).toBe('Hello world');
    });
});

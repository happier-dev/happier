import { beforeEach, describe, expect, it } from 'vitest';

import { createTranscriptStreamSegmentAssembler } from "./transcriptStreamSegmentAssembly.js";
import type { RawRecord } from '../raw/schemas.js';

let assembler = createTranscriptStreamSegmentAssembler();
const applyTranscriptStreamSegmentDelta: typeof assembler.applyTranscriptStreamSegmentDelta = (params) => assembler.applyTranscriptStreamSegmentDelta(params);
const isTranscriptStreamSegmentAssemblyReady: typeof assembler.isTranscriptStreamSegmentAssemblyReady = (...params) => assembler.isTranscriptStreamSegmentAssemblyReady(...params);
const noteTranscriptStreamSegmentSnapshot: typeof assembler.noteTranscriptStreamSegmentSnapshot = (params) => assembler.noteTranscriptStreamSegmentSnapshot(params);
const releaseTranscriptStreamSegmentAssemblyForSession = (sessionId: string) => assembler.releaseTranscriptStreamSegmentAssemblyForSession(sessionId);

function agentMessageRecord(text: string): RawRecord {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            agentId: 'codex',
            data: { type: 'message', message: text },
        },
    };
}

describe('releaseTranscriptStreamSegmentAssemblyForSession', () => {
    beforeEach(() => {
        assembler = createTranscriptStreamSegmentAssembler();
    });

    it('keeps clients following the same session independent', () => {
        const other = createTranscriptStreamSegmentAssembler();
        noteTranscriptStreamSegmentSnapshot({ sessionId: 'same', localId: 'segment', record: agentMessageRecord('first'), tick: 1 });
        other.noteTranscriptStreamSegmentSnapshot({ sessionId: 'same', localId: 'segment', record: agentMessageRecord('second client'), tick: 10 });
        expect(applyTranscriptStreamSegmentDelta({ sessionId: 'same', localId: 'segment', deltaText: '!', tick: 2, baseLength: 5 })).toBe('first!');
        other.releaseTranscriptStreamSegmentAssemblyForSession('same');
        expect(isTranscriptStreamSegmentAssemblyReady('same', 'segment')).toBe(true);
    });

    it('retains active delta chains until their segment or session is released', () => {
        for (let index = 0; index < 40; index++) {
            noteTranscriptStreamSegmentSnapshot({ sessionId: `session-${index}`, localId: 'segment', record: agentMessageRecord('text'), tick: 1 });
        }

        expect(applyTranscriptStreamSegmentDelta({ sessionId: 'session-0', localId: 'segment', deltaText: '!', tick: 2, baseLength: 4 })).toBe('text!');
        noteTranscriptStreamSegmentSnapshot({ sessionId: 'session-0', localId: 'segment', record: {
            ...agentMessageRecord('text!'),
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'segment', segmentState: 'complete' } },
        }, tick: 3 });
        expect(isTranscriptStreamSegmentAssemblyReady('session-0', 'segment')).toBe(false);
        releaseTranscriptStreamSegmentAssemblyForSession('session-39');
        expect(isTranscriptStreamSegmentAssemblyReady('session-39', 'segment')).toBe(false);
        expect(isTranscriptStreamSegmentAssemblyReady('session-1', 'segment')).toBe(true);
    });

    it('drops every tracked segment of the released session and keeps other sessions intact', () => {
        noteTranscriptStreamSegmentSnapshot({ sessionId: 's-evicted', localId: 'seg-1', record: agentMessageRecord('abc'), tick: 1 });
        noteTranscriptStreamSegmentSnapshot({ sessionId: 's-evicted', localId: 'seg-2', record: agentMessageRecord('def'), tick: 1 });
        noteTranscriptStreamSegmentSnapshot({ sessionId: 's-kept', localId: 'seg-1', record: agentMessageRecord('xyz'), tick: 1 });

        releaseTranscriptStreamSegmentAssemblyForSession('s-evicted');

        expect(isTranscriptStreamSegmentAssemblyReady('s-evicted', 'seg-1')).toBe(false);
        expect(isTranscriptStreamSegmentAssemblyReady('s-evicted', 'seg-2')).toBe(false);
        expect(isTranscriptStreamSegmentAssemblyReady('s-kept', 'seg-1')).toBe(true);

        // A late delta for a released segment is dropped (resync happens via next snapshot).
        expect(applyTranscriptStreamSegmentDelta({
            sessionId: 's-evicted',
            localId: 'seg-1',
            deltaText: 'd',
            tick: 2,
            baseLength: 3,
        })).toBeNull();

        // The kept session keeps chaining normally.
        expect(applyTranscriptStreamSegmentDelta({
            sessionId: 's-kept',
            localId: 'seg-1',
            deltaText: '!',
            tick: 2,
            baseLength: 3,
        })).toBe('xyz!');
    });

    it('resyncs a released segment from the next full snapshot', () => {
        noteTranscriptStreamSegmentSnapshot({ sessionId: 's-evicted', localId: 'seg-1', record: agentMessageRecord('abc'), tick: 3 });
        releaseTranscriptStreamSegmentAssemblyForSession('s-evicted');

        noteTranscriptStreamSegmentSnapshot({ sessionId: 's-evicted', localId: 'seg-1', record: agentMessageRecord('abcdef'), tick: 7 });
        expect(applyTranscriptStreamSegmentDelta({
            sessionId: 's-evicted',
            localId: 'seg-1',
            deltaText: 'g',
            tick: 8,
            baseLength: 6,
        })).toBe('abcdefg');
    });
});

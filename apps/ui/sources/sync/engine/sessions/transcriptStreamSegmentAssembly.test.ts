import { afterEach, describe, expect, it } from 'vitest';

import {
    applyTranscriptStreamSegmentDelta,
    isTranscriptStreamSegmentAssemblyReady,
    noteTranscriptStreamSegmentSnapshot,
    releaseTranscriptStreamSegmentAssemblyForSession,
    resetTranscriptStreamSegmentAssemblyForTests,
} from './transcriptStreamSegmentAssembly';

function agentMessageRecord(text: string) {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            data: { type: 'message', message: text },
        },
    } as any;
}

describe('releaseTranscriptStreamSegmentAssemblyForSession', () => {
    afterEach(() => {
        resetTranscriptStreamSegmentAssemblyForTests();
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

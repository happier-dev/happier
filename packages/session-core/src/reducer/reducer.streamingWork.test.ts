import {describe, expect, it} from 'vitest';
import {createReducer, reducer, type ReducerMessage} from './reducer.js';
import type {NormalizedMessage} from '../raw/index.js';
import {applyReducedMessages} from '../transcript/orderedMessages.js';

class CountedMessages extends Map<string, ReducerMessage> {
    visits = 0;
    lookups = 0;
    override get(key: string) { this.lookups++; return super.get(key); }
    override *[Symbol.iterator]() { for (const row of super[Symbol.iterator]()) { this.visits++; yield row; } }
    override *values() { for (const row of super.values()) { this.visits++; yield row; } }
    override *entries() { for (const row of super.entries()) { this.visits++; yield row; } }
    override forEach(callback: (value: ReducerMessage, key: string, map: Map<string, ReducerMessage>) => void, thisArg?: unknown) {
        super.forEach((value, key) => { this.visits++; callback.call(thisArg, value, key, this); });
    }
}

describe('streaming transcript work', () => {
    it('keeps an existing root stream visible when a sidechain snapshot reuses its local id', () => {
        const state = createReducer();
        const root: NormalizedMessage = {
            id: 'root', localId: 'shared-segment', createdAt: 1, seq: 1, role: 'agent', isSidechain: false,
            content: [{type: 'text', text: 'first', uuid: 'root', parentUUID: null}],
            meta: {happierStreamSegmentV1: {v: 1, segmentKind: 'assistant', segmentLocalId: 'shared-segment',
                segmentState: 'streaming', updatedAtMs: 1}},
        };
        const initial = reducer(state, [root], null).messages;
        const child = {...root, id: 'child', seq: 2, isSidechain: true, sidechainId: 'side',
            content: [{type: 'text' as const, text: 'second', uuid: 'child', parentUUID: null}],
            meta: {happierStreamSegmentV1: {v: 1, segmentKind: 'assistant', segmentLocalId: 'shared-segment',
                segmentState: 'streaming', updatedAtMs: 2}},
        } satisfies NormalizedMessage & {sidechainId: string};
        const updated = reducer(state, [child], null).messages;
        // A local-id upsert does not insert the existing row into a sidechain.
        // Preserve that canonical membership instead of hiding the root row.
        expect(updated).toEqual([expect.objectContaining({id: initial[0]!.id, text: 'second'})]);
        expect(state.sidechains.get('side')).toEqual([]);
    });

    it.each([10, 100, 1000])('does not visit retained history for a changed text row (%i historical rows)', history => {
        const state = createReducer();
        const rows: NormalizedMessage[] = Array.from({length: history}, (_, index) => ({
            id: `user-${index}`, seq: index + 1, localId: null, createdAt: index + 1,
            isSidechain: false, role: 'user', content: {type: 'text', text: 'history'},
        }));
        let transcript = applyReducedMessages({messageIdsOldestFirst: [], messagesById: {}}, reducer(state, rows, null).messages);
        const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
            id: 'stream', seq: history + 1, localId: 'stream', createdAt: history + 1,
            role: 'agent', isSidechain: false, content: [{type: 'text', text, uuid: 'stream', parentUUID: null}],
            meta: {happierStreamSegmentV1: {v: 1, segmentKind: 'assistant', segmentLocalId: 'stream',
                segmentState: 'streaming', startedAtMs: history + 1, updatedAtMs}},
        });
        transcript = applyReducedMessages(transcript, reducer(state, [chunk('first', history + 1)], null).messages);
        const counted = new CountedMessages(state.messages);
        state.messages = counted;
        const ids = transcript.messageIdsOldestFirst;
        const oldMessage = transcript.messagesById[ids.at(-1)!];
        for (let tick = 2; tick <= 5; tick++) {
            const changed = reducer(state, [chunk(`chunk ${tick}`, history + tick)], null).messages;
            expect(changed).toHaveLength(1);
            const next = applyReducedMessages(transcript, changed);
            expect(next.messageIdsOldestFirst).toBe(ids);
            expect(next.messagesById[ids[0]!]).toBe(transcript.messagesById[ids[0]!]);
            expect(transcript.messagesById[ids.at(-1)!]).not.toBe(next.messagesById[ids.at(-1)!]);
            transcript = next;
        }
        expect(oldMessage).toMatchObject({text: 'first'});
        // Zero is the contract: changed rows are looked up by id. A timeline
        // iteration per chunk is invalid even when the example history is short.
        expect(counted.visits).toBe(0);
        console.info(JSON.stringify({history, chunks: 4, historyVisits: counted.visits, rowLookups: counted.lookups}));
    });
});

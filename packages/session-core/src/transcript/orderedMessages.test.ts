import { describe, expect, it } from 'vitest';
import { sortTranscriptMessagesOldestFirst } from '../messages/transcriptOrdering.js';
import { applyReducedMessages, createReducer, reducer, type AgentState, type Message, type NormalizedMessage, type OrderedTranscript } from '../index.js';

function message(id: string, seq: number, text = id): Message {
    return { kind: 'agent-text', id, seq, createdAt: seq, localId: null, text };
}

describe('ordered transcript', () => {
    it.each(['pending', 'approved', 'canceled'] as const)('keeps an older %s question in history as new committed rows arrive', (status) => {
        const request = { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [] }, createdAt: 150 };
        const agentState: AgentState = status === 'pending'
            ? { requests: { question: request } }
            : { completedRequests: { question: { ...request, status, completedAt: 175 } } };
        const state = createReducer();
        let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        const row = (id: string, seq: number, createdAt: number): NormalizedMessage => ({
            id, seq, localId: null, createdAt, isSidechain: false, role: 'user',
            content: { type: 'text', text: id },
        });
        const apply = (rows: NormalizedMessage[]) => {
            transcript = applyReducedMessages(transcript, reducer(state, rows, agentState).messages);
            return transcript.messageIdsOldestFirst.map(id => {
                const message = transcript.messagesById[id]!;
                return message.kind === 'tool-call' ? message.tool.permission?.id : message.kind === 'user-text' ? message.text : id;
            });
        };
        expect(apply([row('after', 3, 200)])).toEqual(status === 'pending' ? ['question', 'after'] : ['after']);
        expect(apply([row('before', 1, 100)])).toEqual(['before', 'question', 'after']);
        expect(apply([row('later', 4, 300)])).toEqual(['before', 'question', 'after', 'later']);
        expect(apply([row('old-page', 0, 50)])).toEqual(['old-page', 'before', 'question', 'after', 'later']);
        const question = Object.values(transcript.messagesById).find(message => message.kind === 'tool-call');
        expect(question).not.toHaveProperty('seq');
    });

    it('reconciles cached projection order, cancellation, and the later durable tool row', () => {
        const question: Message = { kind: 'tool-call', id: 'question', localId: null, createdAt: 150, children: [],
            tool: { id: 'request', name: 'AskUserQuestion', state: 'running', input: { questions: [] },
                createdAt: 150, startedAt: null, completedAt: null, description: null,
                permission: { id: 'request', kind: 'user_action', status: 'pending' } } };
        const before = { ...message('before', 1), createdAt: 100 };
        const after = { ...message('after', 3), createdAt: 200 };
        const later = { ...message('later', 4), createdAt: 300 };
        // A retained pre-fix list contains the old request after committed history.
        const cached: OrderedTranscript = { messageIdsOldestFirst: ['before', 'after', 'question'],
            messagesById: { before, after, question } };
        const repaired = applyReducedMessages(cached, [later]);
        expect(repaired.messageIdsOldestFirst).toEqual(['before', 'question', 'after', 'later']);
        expect(sortTranscriptMessagesOldestFirst(Object.values(repaired.messagesById)).map(row => row.id))
            .toEqual(repaired.messageIdsOldestFirst);
        const canceled: Message = { ...question, tool: { ...question.tool, state: 'error', completedAt: 250,
            permission: { ...question.tool.permission!, status: 'canceled' } } };
        const completed = applyReducedMessages(repaired, [canceled]);
        expect(completed.messageIdsOldestFirst).toBe(repaired.messageIdsOldestFirst);
        const committed = applyReducedMessages(completed, [{ ...canceled, seq: 2, realID: 'server-tool' }]);
        expect(committed.messageIdsOldestFirst).toEqual(['before', 'question', 'after', 'later']);
        expect(Object.keys(committed.messagesById)).toHaveLength(4);
        expect(committed.messagesById.question).toMatchObject({ seq: 2, tool: { permission: { status: 'canceled' } } });
    });

    it('does not read historical row bodies for text updates or appends after a placed question', () => {
        const history = Array.from({ length: 1_000 }, (_, i) => message('history-' + i, i));
        const question: Message = { kind: 'tool-call', id: 'question', localId: null, createdAt: 500.5, children: [],
            tool: { name: 'AskUserQuestion', state: 'error', input: {}, createdAt: 500.5,
                startedAt: null, completedAt: 501, description: null,
                permission: { id: 'request', status: 'canceled' } } };
        const initial = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, [...history, question]);
        let reads = 0;
        for (const row of history.slice(0, -1)) {
            const createdAt = row.createdAt;
            Object.defineProperty(row, 'createdAt', { get: () => { reads++; return createdAt; } });
        }
        const revised = applyReducedMessages(initial, [message('history-999', 999, 'revised')]);
        expect(revised.messageIdsOldestFirst).toBe(initial.messageIdsOldestFirst);
        const appended = applyReducedMessages(revised, [message('new', 1_000)]);
        expect(appended.messageIdsOldestFirst.at(-1)).toBe('new');
        expect(reads).toBe(0);
    });

    it('uses request time alongside other unsequenced rows without changing committed sequence order', () => {
        const question: Message = { kind: 'tool-call', id: 'question', localId: null, createdAt: 150, children: [],
            tool: { name: 'AskUserQuestion', state: 'error', input: {}, createdAt: 150,
                startedAt: null, completedAt: 175, description: null,
                permission: { id: 'request', status: 'canceled' } } };
        const early: Message = { kind: 'agent-text', id: 'early', createdAt: 100, localId: null, text: 'early' };
        const late: Message = { kind: 'agent-text', id: 'late', createdAt: 200, localId: null, text: 'late' };
        expect(sortTranscriptMessagesOldestFirst([late, question, early]).map(row => row.id))
            .toEqual(['early', 'question', 'late']);
        const committed = sortTranscriptMessagesOldestFirst([
            { ...message('reply', 2), createdAt: 100 }, question,
            { ...message('submitted', 1), createdAt: 200 },
        ]);
        expect(committed.filter(row => row.seq !== undefined).map(row => row.id)).toEqual(['submitted', 'reply']);
    });

    it('repositions an existing unsequenced tool when late permission details identify its timeline projection', () => {
        const before = { ...message('before', 1), createdAt: 100 };
        const after = { ...message('after', 3), createdAt: 200 };
        const tool: Message = { kind: 'tool-call', id: 'question', localId: null, createdAt: 150, children: [],
            tool: { name: 'AskUserQuestion', state: 'error', input: {}, createdAt: 150,
                startedAt: null, completedAt: 175, description: null } };
        const initial = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, [before, after, tool]);
        expect(initial.messageIdsOldestFirst).toEqual(['before', 'after', 'question']);
        const updated: Message = { ...tool, tool: { ...tool.tool,
            permission: { id: 'request', status: 'canceled' } } };
        const placed = applyReducedMessages(initial, [updated]);
        expect(placed.messageIdsOldestFirst).toEqual(['before', 'question', 'after']);
    });

    it('retains unchanged rows and order references and returns the previous transcript for no-op output', () => {
        const first = message('first', 1);
        const previous: OrderedTranscript = { messageIdsOldestFirst: ['first'], messagesById: { first } };
        expect(applyReducedMessages(previous, [])).toBe(previous);
        expect(applyReducedMessages(previous, [first])).toBe(previous);
        const appended = applyReducedMessages(previous, [message('next', 2)]);
        expect(appended.messageIdsOldestFirst).toEqual(['first', 'next']);
        expect(appended.messagesById.first).toBe(first);
        expect(appended.messagesById).not.toBe(previous.messagesById);
        expect(previous.messagesById).toEqual({ first });
        const next = appended.messagesById.next;
        const revised = applyReducedMessages(appended, [message('next', 2, 'revised')]);
        expect(revised.messageIdsOldestFirst).toBe(appended.messageIdsOldestFirst);
        expect(revised.messagesById).not.toBe(appended.messagesById);
        expect(appended.messagesById.next).toBe(next);
        expect(appended.messagesById.next?.kind === 'agent-text' && appended.messagesById.next.text).toBe('next');
        expect(revised.messagesById.first).toBe(first);
        expect(revised.messagesById.next?.kind === 'agent-text' && revised.messagesById.next.text).toBe('revised');
    });

    it('keeps delayed committed input before its reply when an unsequenced stream is present', () => {
        const streaming: Message = {
            kind: 'agent-text', id: 'streaming', localId: 'stream-local', createdAt: 2_000,
            text: 'Working.', isThinking: true,
        };
        const reply = { ...message('reply', 13), createdAt: 1_000 };
        const submitted: Message = {
            kind: 'user-text', id: 'submitted', localId: 'voice-input', seq: 12,
            createdAt: 3_000, text: 'question',
        };
        const empty: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        const initial = applyReducedMessages(empty, [streaming]);
        const answered = applyReducedMessages(initial, [reply]);
        const committed = applyReducedMessages(answered, [submitted]);

        expect(committed.messageIdsOldestFirst).toEqual(['submitted', 'reply', 'streaming']);
        expect(committed.messagesById.reply).toBe(reply);
        expect(committed.messagesById.streaming).toBe(streaming);
    });

    it('merges older pages and repositions rows when durable ordering arrives', () => {
        const previous: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        const initial = applyReducedMessages(previous, [message('tail', 4), message('middle', 2)]);
        const revised = applyReducedMessages(initial, [message('first', 1), message('middle', 5)]);
        expect(revised.messageIdsOldestFirst).toEqual(['first', 'tail', 'middle']);
        expect(Object.keys(revised.messagesById)).toHaveLength(3);
    });

    it('keeps retained snapshots enumerable and unchanged through repeated row revisions', () => {
        const first = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, [
            message('first', 1), message('tail', 2),
        ]);
        let current = first;
        for (let revision = 0; revision < 1000; revision++) {
            current = applyReducedMessages(current, [message('tail', 2, String(revision))]);
        }
        expect(first.messagesById.tail).toMatchObject({ text: 'tail' });
        expect(current.messagesById.tail).toMatchObject({ text: '999' });
        expect(current.messageIdsOldestFirst).toBe(first.messageIdsOldestFirst);
        expect(Object.keys(current.messagesById)).toEqual(['first', 'tail']);
        expect({ ...current.messagesById }).toEqual({ first: first.messagesById.first, tail: current.messagesById.tail });
        expect(JSON.parse(JSON.stringify(current.messagesById))).toEqual({ ...current.messagesById });
    });

    it('retains distinct keys with colliding hashes and normal Record enumeration order', () => {
        // These distinct ids collide under the record's FNV-1a hash. Updates
        // must still address exact ids, never the hash alone.
        const ids = ['costarring', 'liquid', '10', '2', '4294967295'];
        const first = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, ids.map((id, index) => message(id, index)));
        const revised = applyReducedMessages(first, [message('costarring', 0, 'changed')]);
        expect(revised.messagesById.costarring).toMatchObject({text: 'changed'});
        expect(revised.messagesById.liquid).toBe(first.messagesById.liquid);
        expect(first.messagesById.costarring).toMatchObject({text: 'costarring'});
        expect(Object.keys(revised.messagesById)).toEqual(['2', '10', 'costarring', 'liquid', '4294967295']);
        expect(Object.prototype.hasOwnProperty.call(revised.messagesById, 'liquid')).toBe(true);
    });
});

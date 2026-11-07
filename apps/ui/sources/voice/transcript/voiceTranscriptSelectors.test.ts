import { describe, expect, it } from 'vitest';

// A consumer-requested page in the fixtures, not a product retention ceiling.
const VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW = 200;
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import { voiceMomentsTranslations } from '@/text/translations/voiceMomentsTranslations';

function buildUserMessage(seq: number) {
    return {
        id: `m-${seq}`,
        localId: `m-${seq}`,
        createdAt: seq,
        isSidechain: false,
        role: 'user' as const,
        content: { type: 'text', text: `msg-${seq}` },
    };
}

function buildCountingUserMessage(seq: number, reads: { count: number }) {
    const message = buildUserMessage(seq);
    return {
        ...message,
        get content() {
            reads.count += 1;
            return { type: 'text', text: `msg-${seq}` };
        },
    };
}

function buildCanonicalCountingSession(
    total: number,
    reads: { visited: number; content: number },
) {
    const messageIdsOldestFirst: string[] = [];
    const messagesById: Record<string, ReturnType<typeof buildUserMessage>> = {};

    for (let index = 1; index <= total; index += 1) {
        const id = `m-${index}`;
        const message = buildUserMessage(index);
        Object.defineProperty(message, 'content', {
            configurable: true,
            get() {
                reads.content += 1;
                return { type: 'text', text: index > total - 3 ? '   ' : `msg-${index}` };
            },
        });
        messageIdsOldestFirst.push(id);
        messagesById[id] = message;
    }

    const countedMessagesById = new Proxy(messagesById, {
        get(target, property, receiver) {
            if (typeof property === 'string' && property.startsWith('m-')) {
                reads.visited += 1;
            }
            return Reflect.get(target, property, receiver);
        },
    });

    return { messageIdsOldestFirst, messagesById: countedMessagesById };
}

describe('voiceTranscriptSelectors', () => {
    it('renders a persisted continuation relative to each viewer, never its author’s first-person body', () => {
        const state = { sessionMessages: { conversation: { messages: [{
            kind: 'agent-text', id: 'continuation', createdAt: 1, text: 'Voice continued on this device.',
            meta: { happier: { kind: 'voice_note.v1', payload: { v: 1, continuation: {
                v: 1, deviceId: 'new-device', deviceDisplayName: 'Alice’s phone',
                conversation: { serverId: 'home', sessionId: 'conversation' },
            } } } },
        }] } } };
        const oldViewer = selectVoiceTranscriptEntriesForConversationSession(state, 'conversation', { viewerDeviceId: 'old-device' });
        expect(oldViewer[0]?.text).toBe(voiceMomentsTranslations.en.continuedOn({ device: 'Alice’s phone' }));
        const authorViewer = selectVoiceTranscriptEntriesForConversationSession(state, 'conversation', { viewerDeviceId: 'new-device' });
        expect(authorViewer[0]?.text).not.toBe(oldViewer[0]?.text);
        expect(selectVoiceTranscriptEntriesForConversationSession(state, 'conversation', { viewerDeviceId: 'new-device' })).toBe(authorViewer);
        const legacy = { sessionMessages: { conversation: { messages: [{ ...state.sessionMessages.conversation.messages[0],
            meta: { happier: { kind: 'voice_note.v1', payload: { v: 1 } } }, text: 'An ordinary old note',
        }] } } };
        expect(selectVoiceTranscriptEntriesForConversationSession(legacy, 'conversation')[0]?.text).toBe('An ordinary old note');
    });
    it('uses the canonical local id when a persisted acknowledgement also has a server id', () => {
        const entries = selectVoiceTranscriptEntriesForConversationSession({
            sessionMessages: {
                'carrier-s1': {
                    messages: [{
                        id: 'store-key',
                        realID: 'server-id',
                        localId: 'voice-realtime:attempt-1:assistant:item-1',
                        createdAt: 100,
                        isSidechain: false,
                        role: 'agent',
                        content: [{ type: 'text', text: 'Persisted final' }],
                    }],
                },
            },
        }, 'carrier-s1');

        expect(entries[0]?.id).toBe('voice-realtime:attempt-1:assistant:item-1');
    });

    it('does not classify assistant transcript text as a note solely because it starts with the legacy [Voice] prefix', () => {
        const entries = selectVoiceTranscriptEntriesForConversationSession(
            {
                sessionMessages: {
                    'carrier-s1': {
                        messages: [
                            {
                                id: 'm-assistant',
                                localId: 'm-assistant',
                                createdAt: 200,
                                isSidechain: false,
                                role: 'agent',
                                content: [{ type: 'text', text: '[Voice] legacy-looking assistant text', uuid: 'u2', parentUUID: null }],
                            },
                        ],
                    },
                },
            },
            'carrier-s1',
        );

        expect(entries).toEqual([
            { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: '[Voice] legacy-looking assistant text' },
        ]);
    });

    it('keeps every loaded transcript row available when no display window is requested', () => {
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 50;
        const messages = Array.from({ length: total }, (_unused, index) => buildUserMessage(index + 1));
        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-s1': { messages } } },
            'carrier-s1',
        );

        expect(entries).toHaveLength(total);
        expect(entries[0]?.id).toBe('m-1');
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);
    });

    it('honors a requested larger page and keeps the unchanged projection stable', () => {
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW * 3;
        const messages = Array.from({ length: total }, (_unused, index) => buildUserMessage(index + 1));
        const slice = { messages };
        const state = { sessionMessages: { 'carrier-s1': slice } };

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            state,
            'carrier-s1',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 400 },
        );

        expect(entries).toHaveLength(total);
        expect(entries[0]?.id).toBe('m-1');
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);

        expect(selectVoiceTranscriptEntriesForConversationSession(state, 'carrier-s1',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 400 })).toBe(entries);
    });

    it('scopes recompute to the active conversation and keeps referential stability for unchanged sessions', () => {
        const sessionA = { messages: [buildUserMessage(1), buildUserMessage(2)] };
        const sessionB = { messages: [buildUserMessage(10)] };
        const state = { sessionMessages: { A: sessionA, B: sessionB } as Record<string, unknown> };

        const firstA = selectVoiceTranscriptEntriesForConversationSession(state, 'A');

        // A change to session B swaps the whole sessionMessages map reference (new store
        // snapshot) but leaves session A's slice reference untouched. Re-selecting A must
        // return the SAME result object: changing B does not recompute A.
        const nextState = { sessionMessages: { A: sessionA, B: { messages: [buildUserMessage(10), buildUserMessage(11)] } } };
        const secondA = selectVoiceTranscriptEntriesForConversationSession(nextState, 'A');
        expect(secondA).toBe(firstA);

        // Mutating A's slice reference does recompute A (a new result object).
        const changedState = { sessionMessages: { A: { messages: [...sessionA.messages, buildUserMessage(3)] }, B: sessionB } };
        const thirdA = selectVoiceTranscriptEntriesForConversationSession(changedState, 'A');
        expect(thirdA).not.toBe(firstA);
        expect(thirdA).toHaveLength(3);
    });

    it('projects only the rendered window, not every message it then discards', () => {
        // Real measurement, not arithmetic: each message counts the reads of its
        // own `content`, which is the field text extraction has to touch. A long
        // conversation re-projects on every append, so paying that per-message
        // cost for every message outside the window is the whole defect.
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW * 5;
        const reads = { count: 0 };
        const messages = Array.from({ length: total }, (_unused, index) =>
            buildCountingUserMessage(index + 1, reads));

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-s1': { messages } } },
            'carrier-s1',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW },
        );

        // Same answer as an unbounded projection would give.
        expect(entries).toHaveLength(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        expect(entries[0]?.id).toBe(`m-${total - VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 1}`);
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);
        // …reached without extracting the 800 messages outside the window.
        expect(reads.count).toBe(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
    });

    it('walks the canonical ordered store backward and only visits the bounded suffix needed for renderable rows', () => {
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 10;
        const reads = { visited: 0, content: 0 };
        const session = buildCanonicalCountingSession(total, reads);

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-canonical-bounded': session } },
            'carrier-canonical-bounded',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW },
        );

        expect(entries).toHaveLength(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        expect(entries[0]?.id).toBe('m-8');
        expect(entries[entries.length - 1]?.id).toBe('m-207');
        // Three non-projectable tail messages are visited before the 200 rows
        // are admitted; all older messages remain untouched.
        expect(reads.visited).toBe(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 3);
        expect(reads.content).toBe(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 3);
    });

    it('keeps the exact newest window for legacy input the store never ordered', () => {
        // Older persisted slices are not guaranteed to be in projection order, so
        // the bounded walk still has to establish the order before taking a tail.
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 40;
        const ascending = Array.from({ length: total }, (_unused, index) => buildUserMessage(index + 1));
        const shuffled = [...ascending];
        for (let index = 0; index < shuffled.length; index += 1) {
            const swapWith = (index * 7 + 3) % shuffled.length;
            const held = shuffled[index]!;
            shuffled[index] = shuffled[swapWith]!;
            shuffled[swapWith] = held;
        }
        expect(shuffled.map((message) => message.createdAt)).not.toEqual(
            ascending.map((message) => message.createdAt),
        );

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-unordered': { messages: shuffled } } },
            'carrier-unordered',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW },
        );

        expect(entries.map((entry) => entry.id)).toEqual(
            ascending
                .slice(total - VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW)
                .map((message) => message.id),
        );
    });

    it('keeps a text-free message from shrinking the rendered window', () => {
        // The window counts projected entries, not stored messages: a message with
        // no renderable text is skipped and the walk reaches one further back.
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 10;
        const messages = Array.from({ length: total }, (_unused, index) => {
            const message = buildUserMessage(index + 1);
            // Two blanks inside the window, one outside it.
            return index === total - 3 || index === total - 8 || index === 2
                ? { ...message, content: { type: 'text', text: '   ' } }
                : message;
        });

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-blanks': { messages } } },
            'carrier-blanks',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW },
        );

        expect(entries).toHaveLength(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        expect(entries.some((entry) => entry.id === `m-${total - 2}`)).toBe(false);
        expect(entries.some((entry) => entry.id === `m-${total - 7}`)).toBe(false);
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);
    });

    it('preserves a demanded slice identity beyond the old conversation cache count', () => {
        const buildSession = () => ({ messages: [buildUserMessage(1)] });
        const state: { sessionMessages: Record<string, unknown> } = { sessionMessages: {} };

        // Seed the oldest session and confirm its memo is a stable cache hit.
        state.sessionMessages['s-old'] = buildSession();
        const firstOld = selectVoiceTranscriptEntriesForConversationSession(state, 's-old');
        expect(selectVoiceTranscriptEntriesForConversationSession(state, 's-old')).toBe(firstOld);

        for (let index = 0; index < 65; index += 1) {
            const id = `s-churn-${index}`;
            state.sessionMessages[id] = buildSession();
            selectVoiceTranscriptEntriesForConversationSession(state, id);
        }

        const reselectedOld = selectVoiceTranscriptEntriesForConversationSession(state, 's-old');
        expect(reselectedOld).toBe(firstOld);

        // A recently-queried session stays memoized: the cache still serves hits.
        const recentId = 's-churn-64';
        const recentFirst = selectVoiceTranscriptEntriesForConversationSession(state, recentId);
        expect(selectVoiceTranscriptEntriesForConversationSession(state, recentId)).toBe(recentFirst);
    });
});

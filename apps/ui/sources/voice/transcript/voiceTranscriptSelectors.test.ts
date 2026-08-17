import { describe, expect, it } from 'vitest';

import { VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW, VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX } from './voiceTranscriptBounds';
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';

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

describe('voiceTranscriptSelectors', () => {
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

    it('bounds the rendered transcript window to the most recent items (perf cap)', () => {
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 50;
        const messages = Array.from({ length: total }, (_unused, index) => buildUserMessage(index + 1));
        const entries = selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { 'carrier-s1': { messages } } },
            'carrier-s1',
        );

        // Older items are not surfaced for live render; only the newest window is kept.
        expect(entries).toHaveLength(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        expect(entries[0]?.id).toBe(`m-${total - VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 1}`);
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);
    });

    it('clamps an explicit over-cap limit to the render window and stays newest-kept with referential stability', () => {
        // Churn well past the cap and ask for MORE than the cap via an explicit limit.
        // The explicit limit is the documented over-limit path: before the fix it was
        // honored verbatim, letting the rendered window exceed the 200-entry cap.
        const total = VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW * 3;
        const messages = Array.from({ length: total }, (_unused, index) => buildUserMessage(index + 1));
        const slice = { messages };
        const state = { sessionMessages: { 'carrier-s1': slice } };

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            state,
            'carrier-s1',
            { limit: VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 400 },
        );

        // Hard cap enforced regardless of the over-cap request: ring stays <= cap.
        expect(entries.length).toBeLessThanOrEqual(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        expect(entries).toHaveLength(VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
        // Newest-kept: the most recent `cap` items, ending at the latest message.
        expect(entries[0]?.id).toBe(`m-${total - VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW + 1}`);
        expect(entries[entries.length - 1]?.id).toBe(`m-${total}`);

        // An over-cap explicit limit resolves to the same window as the default, so the
        // unchanged slice returns the SAME result reference (referential stability for
        // unchanged rows): both requests share one cache entry keyed on the clamped limit.
        const defaultWindow = selectVoiceTranscriptEntriesForConversationSession(state, 'carrier-s1');
        expect(defaultWindow).toBe(entries);
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

    it('bounds the per-conversation memo cache under churn (LRU eviction)', () => {
        const buildSession = () => ({ messages: [buildUserMessage(1)] });
        const state: { sessionMessages: Record<string, unknown> } = { sessionMessages: {} };

        // Seed the oldest session and confirm its memo is a stable cache hit.
        state.sessionMessages['s-old'] = buildSession();
        const firstOld = selectVoiceTranscriptEntriesForConversationSession(state, 's-old');
        expect(selectVoiceTranscriptEntriesForConversationSession(state, 's-old')).toBe(firstOld);

        // Query enough distinct sessions to overflow the cache; 's-old' is the
        // least-recently-used key and must be evicted rather than retained forever.
        for (let index = 0; index < VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX; index += 1) {
            const id = `s-churn-${index}`;
            state.sessionMessages[id] = buildSession();
            selectVoiceTranscriptEntriesForConversationSession(state, id);
        }

        // Re-selecting the evicted session recomputes a fresh reference (its slice
        // is unchanged, so a still-cached entry would have returned `firstOld`).
        const reselectedOld = selectVoiceTranscriptEntriesForConversationSession(state, 's-old');
        expect(reselectedOld).not.toBe(firstOld);
        expect(reselectedOld).toEqual(firstOld);

        // A recently-queried session stays memoized: the cache still serves hits.
        const recentId = `s-churn-${VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX - 1}`;
        const recentFirst = selectVoiceTranscriptEntriesForConversationSession(state, recentId);
        expect(selectVoiceTranscriptEntriesForConversationSession(state, recentId)).toBe(recentFirst);
    });
});

import { describe, expect, it } from 'vitest';

import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import { createVoiceSessionBindingStore } from './voiceConversationBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

describe('resolveVoiceSessionComposerRouting', () => {
    it('returns a synthetic binding route for hidden voice conversation sessions backed by adapter text', () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'realtime_elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 123,
        });

        expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-s1', store })).toEqual({
            kind: 'adapter_text',
            binding: {
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'voice-global',
                conversationSessionId: 'carrier-s1',
                transcriptMode: 'synthetic',
                targetSessionId: 's1',
                updatedAt: 123,
            },
        });
    });

    it('routes native hidden voice sessions through the adapter text path', () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'native_session',
            targetSessionId: null,
            updatedAt: 123,
        });

        expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-s1', store })).toEqual({
            kind: 'adapter_text',
            binding: {
                adapterId: 'local_conversation',
                controlSessionId: 'voice-global',
                conversationSessionId: 'carrier-s1',
                transcriptMode: 'native_session',
                targetSessionId: null,
                updatedAt: 123,
            },
        });
    });

    it('rehydrates routing from persisted voice binding metadata when runtime bindings are empty', () => {
        const store = createVoiceSessionBindingStore();

        expect(
            resolveVoiceSessionComposerRouting({
                conversationSessionId: 'carrier-s1',
                store,
                sessionMetadata: writeVoiceConversationBindingMetadata(
                    { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
                    {
                        adapterId: 'realtime_elevenlabs',
                        controlSessionId: 'voice-global',
                        conversationSessionId: 'carrier-s1',
                        transcriptMode: 'synthetic',
                        targetSessionId: 's1',
                        updatedAt: 123,
                    },
                ),
            }),
        ).toEqual({
            kind: 'adapter_text',
            binding: {
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'voice-global',
                conversationSessionId: 'carrier-s1',
                transcriptMode: 'synthetic',
                targetSessionId: 's1',
                updatedAt: 123,
            },
        });
    });

    it('returns null for ordinary sessions', () => {
        const store = createVoiceSessionBindingStore();
        expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 's1', store })).toBeNull();
    });

    it('memoizes the singleton routing lookup for a referentially-stable result on repeat calls', () => {
        // Same conversation id + same sessionMetadata reference -> same result object,
        // so heavy callers (SessionView) do not re-walk state or break memoized children.
        const sessionMetadata = writeVoiceConversationBindingMetadata(
            { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
            {
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'voice-global',
                conversationSessionId: 'carrier-memo',
                transcriptMode: 'synthetic',
                targetSessionId: 's1',
                updatedAt: 1,
            },
        );

        const first = resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-memo', sessionMetadata });
        const second = resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-memo', sessionMetadata });
        expect(second).toBe(first);

        // A different metadata reference recomputes (no stale memo).
        const third = resolveVoiceSessionComposerRouting({
            conversationSessionId: 'carrier-memo',
            sessionMetadata: { ...sessionMetadata },
        });
        expect(third).not.toBe(first);
    });
});

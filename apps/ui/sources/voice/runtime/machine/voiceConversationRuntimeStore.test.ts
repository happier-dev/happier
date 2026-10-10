import { describe, expect, it, vi } from 'vitest';

describe('voiceConversationRuntimeStore', () => {
    it('does not notify subscribers when a snapshot update leaves runtime state unchanged', async () => {
        vi.resetModules();

        const {
            DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
            setVoiceConversationRuntimeSnapshot,
            useVoiceConversationRuntimeStore,
        } = await import('./voiceConversationRuntimeStore');

        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        const listener = vi.fn();
        const unsubscribe = useVoiceConversationRuntimeStore.subscribe(() => listener());

        try {
            setVoiceConversationRuntimeSnapshot({ ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT });
            expect(listener).not.toHaveBeenCalled();

            setVoiceConversationRuntimeSnapshot({
                adapterId: null,
                controlSessionId: 'session-1',
                state: 'listening',
                reconnecting: false,
                micMuted: false,
                error: null,
            });
            expect(listener).toHaveBeenCalledTimes(1);

            setVoiceConversationRuntimeSnapshot((current) => ({ ...current }));
            expect(listener).toHaveBeenCalledTimes(1);

            const inUseVoice = { providerContributionId: 'acme.voice/tts', settingFieldPath: 'voiceName', value: 'a', displayName: 'A' };
            setVoiceConversationRuntimeSnapshot(current => ({ ...current, inUseVoice }));
            expect(useVoiceConversationRuntimeStore.getState().snapshot.inUseVoice).toEqual(inUseVoice);
            expect(listener).toHaveBeenCalledTimes(2);
            setVoiceConversationRuntimeSnapshot(current => ({ ...current, inUseVoice: { ...inUseVoice } }));
            expect(listener).toHaveBeenCalledTimes(2);
        } finally {
            unsubscribe();
        }
    });
});

import { describe, expect, it, vi } from 'vitest';
import { createVoiceMachineError } from './voiceMachineError';

describe('voiceConversationRuntimeStore', () => {
    it('publishes changed startup causes once and retains equal repeated causes', async () => {
        const { DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT, setVoiceConversationRuntimeSnapshot,
            useVoiceConversationRuntimeStore } = await import('./voiceConversationRuntimeStore');
        const publish = (failureReason: 'unknown' | 'model_selection_required') => setVoiceConversationRuntimeSnapshot({
            ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT, controlSessionId: 's1', error: createVoiceMachineError({
                kind: 'provider_error', reason: 'SPAWN_FAILED', cause: {
                    failureCause: { phase: 'client_start', failureReason, code: 'agent_startup_model_reconciliation_failed' },
                },
            }),
        });
        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        const listener = vi.fn();
        const unsubscribe = useVoiceConversationRuntimeStore.subscribe(listener);
        try {
            publish('unknown');
            expect(listener).toHaveBeenCalledTimes(1);
            publish('unknown');
            expect(listener).toHaveBeenCalledTimes(1);
            publish('model_selection_required');
            expect(listener).toHaveBeenCalledTimes(2);
        } finally {
            unsubscribe();
            setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        }
    });
    it('publishes changed operation failure facts and coalesces equivalent parsed diagnostics', async () => {
        const { DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT, setVoiceConversationRuntimeSnapshot,
            useVoiceConversationRuntimeStore } = await import('./voiceConversationRuntimeStore');
        const publish = (httpStatus: number, effectAttempted: boolean) => setVoiceConversationRuntimeSnapshot({
            ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT, controlSessionId: 's1', error: createVoiceMachineError({
                kind: 'provider_error', reason: 'voice_turn_pending', cause: {
                    failureCause: { phase: 'voice.pending.enqueue', errorClass: 'Error', errorCode: null, httpStatus },
                    effectAttempted,
                },
            }),
        });
        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        const listener = vi.fn();
        const unsubscribe = useVoiceConversationRuntimeStore.subscribe(listener);
        try {
            publish(503, false);
            expect(listener).toHaveBeenCalledTimes(1);
            publish(503, false);
            expect(listener).toHaveBeenCalledTimes(1);
            publish(504, false);
            expect(listener).toHaveBeenCalledTimes(2);
            publish(504, true);
            expect(listener).toHaveBeenCalledTimes(3);
        } finally {
            unsubscribe();
            setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        }
    });
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
            const preparedInstructionsFor = { serverId: 'home', sessionId: 'target' };
            setVoiceConversationRuntimeSnapshot(current => ({ ...current, preparedInstructionsFor }));
            expect(listener).toHaveBeenCalledTimes(3);
            setVoiceConversationRuntimeSnapshot(current => ({ ...current, preparedInstructionsFor: { ...preparedInstructionsFor } }));
            expect(listener).toHaveBeenCalledTimes(3);
        } finally {
            unsubscribe();
        }
    });
});

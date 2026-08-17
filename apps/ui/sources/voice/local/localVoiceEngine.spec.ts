import { describe, expect, it } from 'vitest';

import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
} from './localVoiceEngine.testHarness';

describe('local voice engine (turn-based) smoke', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records then transcribes and sends a message on stop', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        await toggleLocalVoiceTurn('s1');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(submitMessage).toHaveBeenCalledWith('s1', 'hello world', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
        });
        // After a turn completes, the local voice session remains active (ready for another turn)
        // until the user explicitly hangs up.
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    }, 120_000);

    it('does not start a local voice turn while realtime voice is connected', async () => {
        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

        // The runtime machine is the single lifecycle source. Drive it into a
        // realtime-owned connected state (the same instance production reads via
        // `getVoiceConversationRuntimeSnapshot()`); the dynamic import resolves to
        // the post-`resetModules` module graph used by the engine under test.
        const { voiceConversationRuntimeMachine } = await import(
            '@/voice/runtime/machine/VoiceConversationRuntimeMachine'
        );
        voiceConversationRuntimeMachine.transitionToConnected({
            controlSessionId: 's-realtime',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        });

        await toggleLocalVoiceTurn('s1');

        // Local voice should not start recording while a realtime call is active.
        expect(getLocalVoiceState().status).toBe('idle');
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it('does not start a local voice turn while any registered realtime adapter owns the machine', async () => {
        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([{
            id: 'future_realtime',
            engineKind: 'realtime',
            start: async () => {},
            stop: async () => {},
            toggle: async () => {},
            interrupt: async () => {},
            setMuted: async () => {},
            sendContextUpdate: () => {},
            getSnapshot: () => ({
                adapterId: 'future_realtime',
                sessionId: 's-future',
                status: 'connected',
                mode: 'idle',
                canStop: true,
            }),
        }]);
        const { voiceConversationRuntimeMachine } = await import(
            '@/voice/runtime/machine/VoiceConversationRuntimeMachine'
        );
        voiceConversationRuntimeMachine.transitionToConnected({
            controlSessionId: 's-future',
            adapterId: 'future_realtime',
        });

        await toggleLocalVoiceTurn('s1');

        expect(getLocalVoiceState().status).toBe('idle');
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it('does not start a local voice turn when realtime is the selected voice provider', async () => {
        const storage = await getStorage();
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(getLocalVoiceState().status).toBe('idle');
        expect(submitMessage).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it } from 'vitest';

import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    localVoiceUploadedAudio,
} from './localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine (turn-based) smoke', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records then transcribes and sends a message on stop', async () => {
        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        await toggleLocalVoiceTurn('s1');
        expect(localVoiceSpeechTranscription).toHaveBeenCalledTimes(1);
        expect(localVoiceUploadedAudio).toEqual(new Uint8Array([1, 2, 3]));
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: 'hello world' },
            }) } }),
        }));
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
        voiceConversationRuntimeMachine.transitionToConnecting({
            controlSessionId: 's-realtime',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        });
        voiceConversationRuntimeMachine.transitionToConnected({
            controlSessionId: 's-realtime',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        });

        await toggleLocalVoiceTurn('s1');

        // Local voice should not start recording while a realtime call is active.
        expect(getLocalVoiceState().status).toBe('idle');
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    });

    it('does not start a local voice turn while another contributed realtime adapter owns the machine', async () => {
        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
        const assembly = (await createBuiltinVoiceAdapterAssembly());
        const contributed = assembly.adapters.find(adapter => adapter.engineKind === 'realtime'
            && adapter.id !== 'happier.voice.elevenlabs/realtime-elevenlabs');
        if (!contributed) throw new Error('Expected another first-party realtime contribution');
        registerVoiceAdapters(assembly.adapters);
        const { voiceConversationRuntimeMachine } = await import(
            '@/voice/runtime/machine/VoiceConversationRuntimeMachine'
        );
        voiceConversationRuntimeMachine.transitionToConnecting({
            controlSessionId: 's-future',
            adapterId: contributed.id,
        });
        voiceConversationRuntimeMachine.transitionToConnected({
            controlSessionId: 's-future',
            adapterId: contributed.id,
        });

        try {
            await toggleLocalVoiceTurn('s1');
            expect(getLocalVoiceState().status).toBe('idle');
            expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        } finally { await assembly.dispose(); }
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
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
    });
});

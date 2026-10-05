import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    emitSpeechRecEvent,
    expoSpeechSpeak,
    expoSpeechStop,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    speechRecStart,
    speechRecStop,
    submitMessage,
} from './localVoiceEngine.testHarness';

const REPLY_TEXT = 'the weather today is sunny and warm outside right now';
const INTERRUPTING_TEXT = 'please cancel that and call my mother instead now';

async function registerControlSessionBinding(): Promise<void> {
    const storage = await getStorage();
    storage.__setState({ sessions: {
        ...storage.getState().sessions,
        s1: { id: 's1', serverId: 'server-a', active: true, updatedAt: Date.now(), metadata: {} },
    } });
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_direct', controlSessionId: 's1', conversationSessionId: 's1',
        conversationSessionAddress: { serverId: 'server-a', sessionId: 's1' },
        transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: Date.now(),
    });
}

async function driveReplyToSpeaking() {
    const storage = await getStorage();
    const config = storage.getState().settings.voice.providers.local_direct.config;
    storage.__setState({ settings: {
        ...storage.getState().settings,
        voice: {
            ...storage.getState().settings.voice,
            providerId: 'local_direct',
            providers: {
                ...storage.getState().settings.voice.providers,
                local_direct: { schemaVersion: 1, config: {
                    ...config,
                    handsFree: { ...config.handsFree, enabled: true,
                        endpointing: { silenceMs: 0, minSpeechMs: 0 } },
                    stt: { ...config.stt, provider: 'device' },
                    tts: { ...config.tts, autoSpeakReplies: true, provider: 'device', bargeInEnabled: true },
                } },
            },
        },
    } });
    let finishSpeak: (() => void) | undefined;
    let stopSpeak: (() => void) | undefined;
    // Only native recognition and native playback are replaced. Capture,
    // endpointing, interruption, submission and transcript projection stay real.
    expoSpeechSpeak.mockImplementationOnce((_text, options) => {
        finishSpeak = options.onDone;
        stopSpeak = options.onStopped;
        options.onStart?.();
    });
    expoSpeechStop.mockImplementation(() => stopSpeak?.());
    speechRecStart.mockImplementation(() => emitSpeechRecEvent('audiostart'));
    speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
    submitMessage.mockImplementationOnce(() => {
        storage.__setState({ sessionMessages: { s1: { messages: [
            { id: 'm1', kind: 'agent-text', text: REPLY_TEXT, createdAt: Date.now() + 60_000 },
        ] } } });
        storage.__notify();
    });
    const engine = await loadLocalVoiceEngineWithCompatState();
    await engine.toggleLocalVoiceTurn('s1');
    const turnPromise = engine.sendLocalVoiceAgentTextTurn('s1', 'what is the forecast');
    await vi.waitFor(() => expect(engine.getLocalVoiceState().status).toBe('speaking'));
    return { engine, turnPromise, finishSpeak: () => finishSpeak?.(), speakingStartedAt: Date.now() };
}

function emitFinal(transcript: string): void {
    emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript, confidence: 0.9 }] });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine real-producer barge-in', () => {
    registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });

    afterEach(async () => {
        vi.restoreAllMocks();
        const [engine, { voiceConversationRuntimeMachine }, { voiceSessionBindingStore },
            { __resetVoiceTurnInterruptions }] = await Promise.all([
            import('./localVoiceEngine'),
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/binding/voiceConversationBindingStore'),
            import('@/voice/transcript/voiceTurnInterruption'),
        ]);
        await engine.stopLocalVoiceSession();
        voiceConversationRuntimeMachine.reset();
        __resetVoiceTurnInterruptions();
        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);
    });

    it.each([
        { name: 'reply echo', transcript: 'the weather today is sunny and warm', elapsedMs: 5_000 },
        { name: 'protected-head speech', transcript: INTERRUPTING_TEXT, elapsedMs: 300 },
        { name: 'backchannel', transcript: 'yeah', elapsedMs: 5_000 },
    ])('suppresses $name and rearms the real recognizer without stopping playback', async ({ transcript, elapsedMs }) => {
        const handle = await driveReplyToSpeaking();
        const readClock = Date.now.bind(Date);
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => readClock() + elapsedMs);
        emitFinal(transcript);
        await vi.waitFor(() => expect(speechRecStart).toHaveBeenCalledTimes(2));
        clock.mockRestore();
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(submitMessage).toHaveBeenCalledTimes(1);
        expect(handle.engine.getLocalVoiceState().status).toBe('speaking');
        handle.finishSpeak();
        await handle.turnPromise;
    }, 180_000);

    it('marks the exact persisted assistant turn interrupted and submits the real captured utterance', async () => {
        await registerControlSessionBinding();
        const handle = await driveReplyToSpeaking();
        const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
        const readClock = Date.now.bind(Date);
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => readClock() + 5_000);
        emitFinal(INTERRUPTING_TEXT);
        await vi.waitFor(() => expect(isVoiceTurnInterrupted('m1')).toBe(true));
        clock.mockRestore();
        await handle.turnPromise;
        await vi.waitFor(() => expect(submitMessage).toHaveBeenCalledWith(
            's1', INTERRUPTING_TEXT, undefined, undefined,
            { callerSurface: 'voice_turn', forceImmediate: true, hostAdmissionOrigin: 'voice' },
        ));
        expect(expoSpeechStop).toHaveBeenCalled();
    }, 180_000);

    it('leaves the persisted assistant turn complete when native playback finishes normally', async () => {
        await registerControlSessionBinding();
        const handle = await driveReplyToSpeaking();
        const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
        handle.finishSpeak();
        await handle.turnPromise;
        expect(isVoiceTurnInterrupted('m1')).toBe(false);
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(submitMessage).toHaveBeenCalledTimes(1);
    }, 180_000);
});

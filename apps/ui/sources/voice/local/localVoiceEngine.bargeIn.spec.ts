import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
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
    localVoicePendingEnqueue,
    localVoiceHomeId,
    acknowledgeLocalVoicePendingEnqueue,
    localVoiceSpeechOutputBoundary,
    publishLocalVoiceAssistantMessage,
    publishLocalVoiceSubmittedUserMessage,
    waitForLocalVoiceBoundaryEvent,
    waitForLocalVoiceState,
} from './localVoiceEngine.testHarness';

const REPLY_TEXT = 'the weather today is sunny and warm outside right now';
const INTERRUPTING_TEXT = 'please cancel that and call my mother instead now';

async function registerControlSessionBinding(): Promise<void> {
    const storage = await getStorage();
    storage.__setState({ sessions: {
        ...storage.getState().sessions,
        s1: { id: 's1', serverId: localVoiceHomeId, active: true, updatedAt: Date.now(), metadata: {} },
    } });
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_direct', controlSessionId: 's1', conversationSessionId: 's1',
        conversationSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' },
        transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: Date.now(),
    });
}

async function driveReplyToSpeaking(handsFree = true, capturedTurn = false) {
    const storage = await getStorage();
    const config = readLocalDirectVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: {
        ...storage.getState().settings,
        voice: {
            ...storage.getState().settings.voice,
            providerId: 'local_direct',
            providers: {
                ...storage.getState().settings.voice.providers,
                local_direct: { schemaVersion: 1, config: {
                    ...config,
                    handsFree: { ...config.handsFree, enabled: handsFree,
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
    localVoicePendingEnqueue.mockImplementation(async request => {
        // The real server commits this input before the Agent replies. Reply
        // admission uses its localId to exclude late-hydrated older answers.
        await publishLocalVoiceSubmittedUserMessage(request);
        await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: `m${localVoicePendingEnqueue.mock.calls.length}`, text: REPLY_TEXT });
        return acknowledgeLocalVoicePendingEnqueue(request);
    });
    const engine = await loadLocalVoiceEngineWithCompatState();
    await engine.toggleLocalVoiceTurn('s1');
    if (capturedTurn) {
        emitFinal('what is the forecast');
    }
    const turnPromise = capturedTurn
        ? engine.commitLocalVoiceInput('s1')
        : engine.sendLocalVoiceAgentTextTurn('s1', 'what is the forecast');
    await Promise.race([
        waitForLocalVoiceState(state => state.status === 'speaking'),
        turnPromise.then(() => {
            throw new Error('Voice turn settled before its held playback started');
        }),
    ]);
    expect(engine.getLocalVoiceState().status).toBe('speaking');
    return { engine, turnPromise, finishSpeak: () => finishSpeak?.(), speakingStartedAt: Date.now() };
}

function emitFinal(transcript: string): void {
    emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript, confidence: 0.9 }] });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine real-producer barge-in', () => {
    registerLocalVoiceEngineHarnessHooks();

    afterEach(async () => {
        const [engine, { voiceConversationRuntimeMachine }, { voiceSessionBindingStore },
            { __resetVoiceTurnInterruptions }] = await Promise.all([
            import('./localVoiceEngine'),
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/binding/voiceConversationBindingStore'),
            import('@/voice/transcript/voiceTurnInterruption'),
        ]);
        await engine.stopLocalVoiceSession();
        const audioAfterEnd = localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot();
        expect(audioAfterEnd.leaseCount).toBe(0);
        voiceConversationRuntimeMachine.reset();
        __resetVoiceTurnInterruptions();
        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);
        vi.restoreAllMocks();
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
        await waitForLocalVoiceBoundaryEvent('recognizer-start', 2);
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        clock.mockRestore();
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
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
        await handle.turnPromise;
        expect(isVoiceTurnInterrupted('m1', 's1')).toBe(true);
        clock.mockRestore();
        await waitForLocalVoiceBoundaryEvent('pending-enqueue', 2);
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: INTERRUPTING_TEXT },
            }) } }),
        }));
        expect(expoSpeechStop).toHaveBeenCalled();
        await waitForLocalVoiceBoundaryEvent('speech', 2);
        await waitForLocalVoiceState(state => state.status === 'recording');
    }, 180_000);

    it('leaves the persisted assistant turn complete when native playback finishes normally', async () => {
        await registerControlSessionBinding();
        const handle = await driveReplyToSpeaking();
        const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
        handle.finishSpeak();
        await handle.turnPromise;
        expect(isVoiceTurnInterrupted('m1', 's1')).toBe(false);
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    }, 180_000);

    it.each([false, true])('preserves correction across playback completion with hands-free %s', async (handsFree) => {
        const handle = await driveReplyToSpeaking(handsFree, !handsFree);
        emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: INTERRUPTING_TEXT, confidence: 0.9 }] });
        handle.finishSpeak();
        await handle.turnPromise;

        // Partial recognition is not an endpoint. Playback completion must leave
        // the same capture listening, so manual Send and a later endpoint work.
        expect(handle.engine.getLocalVoiceState()).toMatchObject({ sessionId: 's1', status: 'recording' });
        expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
        emitFinal(INTERRUPTING_TEXT);
        if (!handsFree) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
            await handle.engine.commitLocalVoiceInput('s1');
            expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(2);
        }
        await waitForLocalVoiceBoundaryEvent('pending-enqueue', 2);
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: INTERRUPTING_TEXT },
            }) } }),
        }));
        await waitForLocalVoiceBoundaryEvent('speech', 2);
        await waitForLocalVoiceState(state => state.status === 'recording');
    }, 180_000);
});

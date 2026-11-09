import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { createDeferred, createSessionMessagesFixture, waitForTestEvent } from '@/dev/testkit';

import {
    audioStreamStart,
    expoSpeechSpeak,
    expoSpeechStop,
    emitSpeechRecEvent,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    setPlatformOs,
    setSpeechRecRecognitionAvailable,
    speechRecAbort,
    speechRecStart,
    speechRecStop,
    speechRecRequestPermissionsAsync,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    nativeMicRequestPermissionsAsync,
    localVoiceHomeId,
    acknowledgeLocalVoicePendingEnqueue,
    publishLocalVoiceAssistantMessage,
    publishLocalVoiceSubmittedUserMessage,
    localVoiceSpeechOutputBoundary,
    readLocalVoiceHttpRequests,
    waitForLocalVoiceBoundaryEvent,
    waitForLocalVoiceState,
} from './localVoiceEngine.testHarness';

async function configureDuplexDeviceSpeech(handsFree: boolean, endpointing = { silenceMs: 0, minSpeechMs: 0 }) {
    speechRecStart.mockImplementation(() => {
        emitSpeechRecEvent('start');
        emitSpeechRecEvent('audiostart');
    });
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
                        endpointing },
                    stt: { ...config.stt, provider: 'device' },
                    tts: { ...config.tts, provider: 'device', autoSpeakReplies: true, bargeInEnabled: true },
                } },
            },
        },
    } });
    return storage;
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine device STT (experimental)', () => {
    registerLocalVoiceEngineHarnessHooks();
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

    it.each([[true, true], [false, false]] as const)('reports whether the capture ends its own turn (hands-free %s)', async (handsFree, endsOnSilence) => {
        await configureDuplexDeviceSpeech(handsFree);
        const engine = await loadLocalVoiceEngineWithCompatState();
        const { createLocalVoiceAdapter } = await import('@/voice/adapters/local/createLocalVoiceAdapter');
        try {
            await engine.toggleLocalVoiceTurn('s1');
            const adapter = createLocalVoiceAdapter('local_direct', { currentUiContext: {} as never });
            expect(adapter.getSnapshot()).toMatchObject({ canCommitInput: true, inputEndsOnSilence: endsOnSilence });
        } finally {
            await engine.stopLocalVoiceSession();
        }
    }, 180_000);

    it('rearms hands-free capture when the submitted coding turn is cancelled remotely without a reply', async () => {
        const storage = await configureDuplexDeviceSpeech(true);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const engine = await loadLocalVoiceEngineWithCompatState();
        try {
            await engine.toggleLocalVoiceTurn('s1');
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'explain the forecast', confidence: 0.9 }] });
            await waitForLocalVoiceBoundaryEvent('pending-enqueue');
            expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
            const request = localVoicePendingEnqueue.mock.calls[0]![0];
            const user = { id: 'voice-user', kind: 'user-text' as const, text: 'explain the forecast',
                localId: String(request.body.localId), seq: 17, createdAt: Date.now() };
            storage.__setState({ sessions: { ...storage.getState().sessions, s1: { ...storage.getState().sessions.s1!,
                sessionTurns: buildSessionTurnsProjectionV1({ sessionId: 's1', updatedAt: Date.now(), turns: [{
                    turnId: 'coding-turn', startedAt: Date.now(), updatedAt: Date.now(), status: 'cancelled',
                    transcriptAnchors: { startUserMessageSeq: user.seq, finalAssistantMessageSeq: null },
                }] }),
            } }, sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: [user.id], messagesById: { [user.id]: user } }) } });
            await waitForLocalVoiceState(state => state.status === 'recording');
            expect(engine.getLocalVoiceState().status).toBe('recording');
            expect(speechRecStart).toHaveBeenCalledTimes(2);
            expect(expoSpeechSpeak).not.toHaveBeenCalled();
        } finally {
            await engine.stopLocalVoiceSession();
        }
    }, 180_000);

    it('keeps three spoken turns connected and retains capture across natural playback completion', async () => {
        await configureDuplexDeviceSpeech(true, readLocalDirectVoiceSettings({ providers: {} }).handsFree.endpointing);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const playbackCompletions: Array<() => void> = [];
        expoSpeechSpeak.mockImplementation((_text, options) => {
            playbackCompletions.push(() => options.onDone?.());
            options.onStart?.();
        });
        let reply = 0;
        localVoicePendingEnqueue.mockImplementation(async request => {
            await publishLocalVoiceSubmittedUserMessage(request);
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: `reply-${++reply}`, text: 'Here is the requested answer.' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });
        const engine = await loadLocalVoiceEngineWithCompatState();
        const [{ renderHook }, { useSessionRealtimeTranscriptConsumer }, { createLocalDirectVoiceAdapter }] = await Promise.all([
            import('@/dev/testkit/hooks/renderHook'),
            import('@/hooks/session/useSessionRealtimeTranscriptConsumer'),
            import('@/voice/adapters/localDirect/localDirectAdapter'),
        ]);
        const transcriptDetail = await renderHook(() => useSessionRealtimeTranscriptConsumer('s1', localVoiceHomeId));
        const adapter = createLocalDirectVoiceAdapter();
        const statuses: string[] = [];
        let unsubscribe = () => {};
        try {
            await engine.toggleLocalVoiceTurn('s1');
            expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
            unsubscribe = adapter.subscribe(() => statuses.push(adapter.getSnapshot().status));
            const utterances = ['explain the forecast', 'describe the wind speed', 'tell me about the rainfall'];
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: utterances[0], confidence: 0.9 }] });
            for (let turn = 0; turn < utterances.length; turn++) {
                await waitForLocalVoiceBoundaryEvent('speech', turn + 1);
                await waitForLocalVoiceState(state => state.status === 'speaking');
                const captureStarts = speechRecStart.mock.calls.length;
                const captureStops = speechRecStop.mock.calls.length;
                // The next utterance begins before playback ends. Finishing TTS
                // must retain this recognizer, including its in-flight audio.
                const nextUtterance = utterances[turn + 1] ?? 'thank you for the explanation';
                emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: nextUtterance, confidence: 0.9 }] });
                playbackCompletions[turn]!();
                await waitForTestEvent(adapter.subscribe, adapter.getSnapshot,
                    snapshot => snapshot.mode === 'listening' && snapshot.canCommitInput === true);
                expect(speechRecStart).toHaveBeenCalledTimes(captureStarts);
                expect(speechRecStop).toHaveBeenCalledTimes(captureStops);
                if (turn + 1 < utterances.length) {
                    emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: nextUtterance, confidence: 0.9 }] });
                }
            }
            expect(localVoicePendingEnqueue.mock.calls.map(([request]) => request.body.content)).toEqual(
                utterances.map(text => ({ t: 'plain', v: expect.objectContaining({ role: 'user', content: { type: 'text', text } }) })),
            );
            expect(statuses).not.toContain('connecting');
            expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
        } finally {
            unsubscribe();
            await engine.stopLocalVoiceSession();
            await transcriptDetail.unmount();
        }
    }, 180_000);

    it.each(['direct interruption', 'after a backchannel', 'manual capture'])(
      'captures a second utterance through the real recognizer while an ordinary spoken reply is held (%s)', async (scenario) => {
        const storage = await configureDuplexDeviceSpeech(scenario !== 'manual capture');
        let finishSpeech: (() => void) | undefined;
        let resolvePlaybackStarted!: () => void;
        const playbackStarted = new Promise<void>(resolve => { resolvePlaybackStarted = resolve; });
        expoSpeechSpeak.mockImplementation((_text, options) => {
            finishSpeech = options.onStopped;
            options.onStart?.();
            resolvePlaybackStarted();
        });
        expoSpeechStop.mockImplementation(() => finishSpeech?.());
        const recognitionEndOrder: number[] = [];
        speechRecStop.mockImplementation(() => {
            recognitionEndOrder.push(speechRecStop.mock.invocationCallOrder.at(-1) ?? 0);
            emitSpeechRecEvent('end');
        });
        localVoicePendingEnqueue.mockImplementationOnce(async request => {
            await publishLocalVoiceSubmittedUserMessage(request);
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: 'reply-one', text: 'The weather will be sunny tomorrow.' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });
        // Fixture realization: a mounted Session transcript-detail surface,
        // not SessionView visibility, background consumption or Home Voice.
        const [{ renderHook }, { useSessionRealtimeTranscriptConsumer }] = await Promise.all([
            import('@/dev/testkit/hooks/renderHook'),
            import('@/hooks/session/useSessionRealtimeTranscriptConsumer'),
        ]);
        const transcriptDetail = await renderHook(() => useSessionRealtimeTranscriptConsumer('s1', localVoiceHomeId));
        const engine = await loadLocalVoiceEngineWithCompatState();
        try {
            const { resolveSessionLiveConsumption } = await import('@/sync/runtime/sessionLiveConsumption');
            await engine.toggleLocalVoiceTurn('s1');
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'what is the forecast', confidence: 0.9 }] });
            const initialTurn = scenario === 'manual capture' ? engine.toggleLocalVoiceTurn('s1') : Promise.resolve();
            let outputFailure: { name: string; message: string } | null = null;
            void initialTurn.catch(error => {
                outputFailure = error instanceof Error
                    ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
            });
            const expectSpeaking = () => expect(engine.getLocalVoiceState().status, JSON.stringify({
                state: engine.getLocalVoiceState(), outputFailure,
                pendingHttpCalls: localVoicePendingEnqueue.mock.calls.length,
                httpRequests: readLocalVoiceHttpRequests().slice(-12).map(({ method, path }) => ({ method, path })),
                liveConsumption: resolveSessionLiveConsumption('s1', localVoiceHomeId),
                transcript: readStoredSessionMessages(storage.getState(), 's1').map(message => ({ id: message.id, kind: message.kind })),
                audioSession: localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot(),
                sdkOrder: { recognitionEndOrder, recognizerStart: speechRecStart.mock.invocationCallOrder,
                    recognizerStop: speechRecStop.mock.invocationCallOrder, speak: expoSpeechSpeak.mock.invocationCallOrder },
            })).toBe('speaking');
            if (scenario === 'manual capture') {
                // Await the real physical playback callback or this public
                // turn's settlement, within the existing case budget. A failed
                // turn still fails the speaking contract with its actual cause.
                await Promise.race([playbackStarted, initialTurn.then(() => undefined, () => undefined)]);
                expectSpeaking();
            } else {
                await playbackStarted;
                expectSpeaking();
            }
            // Capture is live again before the held output finishes, using the actual
            // capture owner and recognizer controller rather than injected endpoints.
            expect(speechRecStart.mock.calls.length).toBe(2);
            await new Promise((resolve) => setTimeout(resolve, 850));
            if (scenario === 'after a backchannel') {
                const playbackStops = expoSpeechStop.mock.calls.length;
                emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'yeah', confidence: 0.9 }] });
                await waitForLocalVoiceBoundaryEvent('recognizer-start', 3);
                expect(speechRecStart.mock.calls.length).toBeGreaterThanOrEqual(3);
                expect(expoSpeechStop.mock.calls.length).toBe(playbackStops);
                expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
            }
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'instead explain the wind speed', confidence: 0.9 }] });
            await waitForLocalVoiceBoundaryEvent('speech-stop');
            expect(expoSpeechStop).toHaveBeenCalled();
            let manualCommit: Promise<void> | undefined;
            if (scenario === 'manual capture') {
                await initialTurn;
                expect(engine.getLocalVoiceState().status).toBe('recording');
                expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
                manualCommit = engine.commitLocalVoiceInput('s1');
                void manualCommit.catch(error => {
                    outputFailure = error instanceof Error
                        ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
                });
            }
            await waitForLocalVoiceBoundaryEvent('pending-enqueue', 2);
            expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                    role: 'user', content: { type: 'text', text: 'instead explain the wind speed' },
                }) } }),
            }));
            await initialTurn;
            await engine.stopLocalVoiceSession();
            await manualCommit;
        } finally {
            await engine.stopLocalVoiceSession();
            // The real hook retires its transcript-consumer registration before
            // the incumbent fixture ends this Account's connection lifetime.
            await transcriptDetail.unmount();
        }
    }, 180_000);

    it('releases the playback capture when the recognized turn fails to send', async () => {
        await configureDuplexDeviceSpeech(false);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const failure = new Error('network_send_failed');
        localVoicePendingEnqueue.mockResolvedValueOnce(Response.json({ error: failure.message }, { status: 400 }));
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'explain the forecast', confidence: 0.9 }] });
        await expect(engine.toggleLocalVoiceTurn('s1')).rejects.toBeInstanceOf(Error);
        expect(engine.getLocalVoiceState()).toMatchObject({ status: 'idle', error: 'send_failed' });
        // Both actual native recognizer generations must be stopped, not just
        // the initial turn whose transcript was submitted.
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        expect(speechRecStop).toHaveBeenCalledTimes(2);
        await engine.stopLocalVoiceSession();
    }, 180_000);

    it('surfaces an automatic endpoint send failure without an unhandled rejection and permits a fresh capture', async () => {
        await configureDuplexDeviceSpeech(true);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        localVoicePendingEnqueue.mockResolvedValueOnce(Response.json({ error: 'request timed out' }, { status: 400 }));
        const unhandled: unknown[] = [];
        const observeUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', observeUnhandled);
        const engine = await loadLocalVoiceEngineWithCompatState();
        try {
            await engine.toggleLocalVoiceTurn('s1');
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'explain the forecast', confidence: 0.9 }] });
            await waitForLocalVoiceState(state => state.status === 'idle' && state.error === 'send_failed');
            expect(engine.getLocalVoiceState()).toMatchObject({ status: 'idle', error: 'send_failed' });
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
            await engine.toggleLocalVoiceTurn('s1');
            expect(engine.getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: 's1' });
        } finally {
            process.off('unhandledRejection', observeUnhandled);
            await engine.stopLocalVoiceSession();
        }
    }, 180_000);

    it('does not submit a late turn when End Voice cancels playback capture startup', async () => {
        const storage = await configureDuplexDeviceSpeech(false);
        let resolvePermission!: (result: { granted: boolean; canAskAgain: boolean }) => void;
        const delayedPermission = new Promise<{ granted: boolean; canAskAgain: boolean }>((resolve) => { resolvePermission = resolve; });
        nativeMicRequestPermissionsAsync.mockResolvedValueOnce({ granted: true, canAskAgain: true });
        const permissionEntered = createDeferred<void>();
        nativeMicRequestPermissionsAsync.mockImplementationOnce(() => { permissionEntered.resolve(); return delayedPermission; });
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        expoSpeechSpeak.mockImplementation((_text, options) => options.onDone?.());
        localVoicePendingEnqueue.mockImplementationOnce(async request => {
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: 'late-reply', text: 'This should not be sent.' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'explain the forecast', confidence: 0.9 }] });
        const turn = engine.toggleLocalVoiceTurn('s1');
        await permissionEntered.promise;
        expect(nativeMicRequestPermissionsAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
        const end = engine.stopLocalVoiceSession();
        resolvePermission({ granted: true, canAskAgain: true });
        await Promise.all([turn, end]);
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        expect(engine.getLocalVoiceState().status).toBe('idle');
    }, 180_000);

    afterEach(() => {
        if (previousWindow === undefined) {
            Reflect.deleteProperty(globalThis as object, 'window');
        } else {
            (globalThis as { window?: object }).window = previousWindow;
        }

        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis as object, 'document');
        } else {
            (globalThis as { document?: object }).document = previousDocument;
        }
    });

    it('keeps mic permission denial visible as a failed attempt instead of entering recording', async () => {
        speechRecRequestPermissionsAsync.mockResolvedValueOnce({ granted: false });

        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(speechRecStart).not.toHaveBeenCalled();
        // Not a graceful idle end: the presence must keep "Microphone blocked" with Allow on screen.
        expect(getLocalVoiceState()).toMatchObject({
            status: 'error',
            sessionId: 's1',
            error: 'mic_permission_denied',
        });
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        expect(getVoiceConversationRuntimeSnapshot().error).toMatchObject({
            kind: 'mic_permission_denied',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'open_settings',
            presentation: 'permission_required',
        });
    });

    it.each(['local_direct', 'local_conversation'] as const)('starts a fresh %s attempt after dismissing a recognizer failure', async (providerId) => {
        await configureDuplexDeviceSpeech(false);
        const storage = await getStorage();
        const settings = storage.getState().settings;
        const config = providerId === 'local_direct' ? readLocalDirectVoiceSettings(settings.voice)
            : readLocalConversationVoiceSettings(settings.voice);
        storage.__setState({ settings: { ...settings, voice: {
            ...settings.voice,
            providerId,
            providers: { ...settings.voice.providers, [providerId]: { schemaVersion: 1, config: {
                ...config, stt: { ...config.stt, provider: 'device' },
                tts: { ...config.tts, autoSpeakReplies: false },
            } } },
        } } });
        await loadLocalVoiceEngineWithCompatState();
        const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { getVoiceSessionEndedAttempt, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        registerVoiceAdapters([createLocalDirectVoiceAdapter(), createLocalConversationVoiceAdapter()]);
        const lifecycle = createVoiceSessionLifecycleController();
        const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const target = { serverId: localVoiceHomeId, sessionId: 's1' };
        try {
            lifecycle.setConfiguredProviderId(providerId);
            await lifecycle.toggle(target);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
            emitSpeechRecEvent('error', { error: 'not-allowed' });
            await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
                snapshot => snapshot.status === 'error' && snapshot.canStop === false && snapshot.errorCode === 'mic_permission_denied');
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'error', canStop: false, errorCode: 'mic_permission_denied',
            });
            const dismissal = lifecycle.dismissFailedAttempt('s1');
            // Dismiss retires the failed attempt through the same physical
            // cleanup owner as End; controls remain until cleanup settles.
            expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: providerId, canStop: true });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            const restart = lifecycle.toggle(target);
            await Promise.all([dismissal, restart]);
            expect(speechRecStart).toHaveBeenCalledTimes(2);
            expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'listening' });
            expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
            expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            await lifecycle.dispose();
        }
    });

    it.each([
        { providerId: 'local_direct', outcome: 'start' },
        { providerId: 'local_conversation', outcome: 'start' },
        { providerId: 'local_direct', outcome: 'cancel' },
        { providerId: 'local_direct', outcome: 'dispose' },
        { providerId: 'local_direct', outcome: 'account' },
        { providerId: 'local_direct', outcome: 'provider' },
    ] as const)('acknowledges pending $providerId Start during End cleanup ($outcome)', async ({ providerId, outcome }) => {
        await configureDuplexDeviceSpeech(false);
        const storage = await getStorage();
        const settings = storage.getState().settings;
        const config = providerId === 'local_direct' ? readLocalDirectVoiceSettings(settings.voice)
            : readLocalConversationVoiceSettings(settings.voice);
        storage.__setState({ settings: { ...settings, voice: {
            ...settings.voice, providerId,
            providers: { ...settings.voice.providers, [providerId]: { schemaVersion: 1, config: {
                ...config, stt: { ...config.stt, provider: 'device' },
                tts: { ...config.tts, autoSpeakReplies: false },
            } } },
        } } });
        await loadLocalVoiceEngineWithCompatState();
        const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { getVoiceSessionEndedAttempt, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        const { resolveVoiceAttemptControl } = await import('@/components/voice/attempt/resolveVoiceAttemptControl');
        const { resolveVoiceSurfaceState } = await import('@/components/voice/surface/resolveVoiceSurfaceState');
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        registerVoiceAdapters([createLocalDirectVoiceAdapter(), createLocalConversationVoiceAdapter()]);
        const lifecycle = createVoiceSessionLifecycleController();
        const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        const target = { serverId: localVoiceHomeId, sessionId: 's1' };
        // The recognizer's OS boundary holds cleanup until it acknowledges End.
        speechRecStop.mockImplementation(() => {});
        try {
            lifecycle.setConfiguredProviderId(providerId);
            await lifecycle.toggle(target);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
            const end = lifecycle.stop('s1').catch((error: unknown) => {
                if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
            });
            const snapshot = lifecycle.getSnapshot();
            expect(snapshot).toMatchObject({ status: 'connected', mode: 'idle', canStop: true });
            const control = resolveVoiceAttemptControl({
                ...snapshot, surfaceState: resolveVoiceSurfaceState(snapshot), tone: 'neutral',
                muted: false, capturing: false, startAdmitted: true, hasRecovery: false,
            });
            expect(control).toMatchObject({ surfaceState: 'live', live: true, primaryAction: 'end' });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            expect(getVoiceConversationRuntimeSnapshot().state).toBe('ending');
            let restartSettled = false;
            const restart = lifecycle.toggle(target).finally(() => { restartSettled = true; });
            const pending = lifecycle.getSnapshot();
            expect(pending).toMatchObject({ adapterId: providerId, sessionId: 's1', status: 'connecting', canStop: true });
            expect(lifecycle.getAttemptTargetSessionAddress()).toEqual(target);
            expect(resolveVoiceAttemptControl({
                ...pending, surfaceState: resolveVoiceSurfaceState(pending), tone: 'pending',
                muted: false, capturing: false, startAdmitted: true, hasRecovery: false,
            })).toMatchObject({ surfaceState: 'connecting', live: true, primaryAction: 'end', capturing: false });
            await Promise.resolve();
            expect(speechRecStart).toHaveBeenCalledTimes(1);
            const cancellation = outcome === 'cancel' ? lifecycle.stop('s1')
                : outcome === 'dispose' ? lifecycle.dispose() : Promise.resolve();
            if (outcome === 'account') lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            if (outcome === 'provider') lifecycle.setConfiguredProviderId('off');
            if (outcome !== 'start') {
                if (outcome !== 'dispose') expect(lifecycle.getSnapshot()).toMatchObject({
                    status: 'connected', mode: 'idle', canStop: true,
                });
                expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
                expect(lifecycle.getSnapshot().errorMessage).toBeUndefined();
                // Cancelling Start retires its observer while the OS still
                // owns capture cleanup and has not acknowledged End.
                await restart;
                expect(restartSettled).toBe(true);
            }
            emitSpeechRecEvent('end');
            await Promise.all([end, restart, cancellation]);
            if (outcome !== 'start') {
                if (outcome === 'dispose') {
                    // Disposal freezes its last publication. The OS release,
                    // rather than that retired snapshot, proves cleanup.
                    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
                } else expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', mode: 'idle', canStop: false });
                expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
            }
            expect(speechRecStart).toHaveBeenCalledTimes(outcome === 'start' ? 2 : 1);
            if (outcome === 'start') {
                expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'listening' });
                expect(getVoiceSessionEndedAttempt()).toBeNull();
            }
            expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        } finally {
            speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
            emitSpeechRecEvent('end');
            unsubscribe();
            await lifecycle.dispose();
        }
    });

    it.each(['unavailable', 'service-not-allowed', 'audio-capture'] as const)('keeps %s speech recognition as a failed attempt after capture cleanup', async (reason) => {
        if (reason === 'audio-capture') setPlatformOs('web');
        await configureDuplexDeviceSpeech(false);
        if (reason === 'unavailable') setSpeechRecRecognitionAvailable(false);
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn('s1');
        if (reason !== 'unavailable') emitSpeechRecEvent('error', { error: reason });

        const { getVoiceConversationRuntimeSnapshot, useVoiceConversationRuntimeStore } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, getVoiceConversationRuntimeSnapshot,
            snapshot => snapshot.error?.kind === 'speech_recognition_unavailable');
        expect(getVoiceConversationRuntimeSnapshot().error).toMatchObject({
            kind: 'speech_recognition_unavailable',
            reason: reason === 'unavailable' ? 'device_stt_unavailable' : reason,
            recoveryAction: 'select_speech_engine',
            presentation: 'error', recoverable: false,
        });
        expect(engine.getLocalVoiceState()).toMatchObject({ status: 'error', sessionId: 's1' });
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        await engine.stopLocalVoiceSession();
    });

    it('projects a spontaneous device end-only termination as a recoverable runtime failure', async () => {
        setPlatformOs('web');
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        emitSpeechRecEvent('end');

        await waitForLocalVoiceState(state => state.status === 'idle' && state.error === 'device_stt_error');
        expect(getLocalVoiceState()).toEqual({
                status: 'idle',
                sessionId: 's1',
                error: 'device_stt_error',
        });
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
            state: 'disconnected',
            error: {
                kind: 'provider_error',
                reason: 'device_stt_error',
                recoverable: true,
                recoveryAction: 'retry',
                presentation: 'notice',
            },
        });
    });

    it('sends recognized text without requiring an STT endpoint', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalled();

        // Simulate native/web recognition delivering a final result before stop.
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'hello from device stt', confidence: 0.9, segments: [] }] });

        const stopPromise = toggleLocalVoiceTurn('s1');

        // Stop should request recognizer stop; engine resolves once `end` fires.
        expect(speechRecStop).toHaveBeenCalled();
        emitSpeechRecEvent('end', {});

        await stopPromise;

        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: 'hello from device stt' },
            }) } }),
        }));
        expect(localVoiceSpeechTranscription.mock.calls.length).toBe(0);
    });

    it('does not request speech recognition permissions on web (requestPermissionsAsync is noisy there)', async () => {
        setPlatformOs('web');

        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalled();
        expect(speechRecRequestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('does not request speech recognition permissions when running in a DOM environment, even if Platform.OS is surprising', async () => {
        setPlatformOs('ios');
        const storage = await getStorage();
        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

        const previousWindow = (globalThis as any).window;
        const previousDocument = (globalThis as any).document;
        (globalThis as any).window = {};
        (globalThis as any).document = {};

        try {
            storage.__setState({
                settings: {
                    ...storage.getState().settings,
                    voice: {
                        ...storage.getState().settings.voice,
                        providerId: 'local_direct',
                        providers: {
                            ...storage.getState().settings.voice.providers,
                            local_direct: { schemaVersion: 1, config: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                                stt: {
                                    ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                    provider: 'device',
                                },
                            } },
                        },
                    },
                },
            });

            await toggleLocalVoiceTurn('s1');
            expect(getLocalVoiceState().status).toBe('recording');
            expect(speechRecStart).toHaveBeenCalled();
            expect(speechRecRequestPermissionsAsync).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
            (globalThis as any).document = previousDocument;
        }
    });

    it('hands-free mode auto-sends final device STT turns and restarts listening', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(1);

        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'hands free message', confidence: 0.9, segments: [] }] });
        await waitForLocalVoiceState(state => state.status === 'transcribing');
        expect(getLocalVoiceState().status).toBe('transcribing');
        emitSpeechRecEvent('end', {});

        await waitForLocalVoiceBoundaryEvent('pending-enqueue');
        expect(localVoicePendingEnqueue.mock.calls.length).toBeGreaterThanOrEqual(1);
        await waitForLocalVoiceBoundaryEvent('recognizer-start', 2);
        expect(speechRecStart.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: 'hands free message' },
            }) } }),
        }));
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('submits a short finalized utterance outside playback and rearms hands-free listening', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(1);

        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'yeah', confidence: 0.9, segments: [] }] });
        await waitForLocalVoiceBoundaryEvent('recognizer-stop');
        expect(speechRecStop.mock.calls.length).toBeGreaterThanOrEqual(1);
        emitSpeechRecEvent('end', {});

        await waitForLocalVoiceBoundaryEvent('recognizer-start', 2);
        await waitForLocalVoiceState(state => state.status === 'recording');
        expect(localVoicePendingEnqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            sessionId: 's1',
            body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: 'yeah' },
            }) } }),
        }));
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('manual toggle while hands-free recording stops recognition and disables loop', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        const stopCallCountBeforeManualToggle = speechRecStop.mock.calls.length;
        const stopPromise = toggleLocalVoiceTurn('s1');
        expect(speechRecStop).toHaveBeenCalledTimes(stopCallCountBeforeManualToggle + 1);
        emitSpeechRecEvent('end', {});
        await stopPromise;

        expect(getLocalVoiceState().status).toBe('idle');
        expect(speechRecStart).toHaveBeenCalledTimes(1);
        expect(speechRecAbort).not.toHaveBeenCalled();
    });

    it('waits for configured silence window before auto-stopping a hands-free turn', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 10, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'timed hands free', confidence: 0.9, segments: [] }] });
        expect(getLocalVoiceState().status).toBe('recording');

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getLocalVoiceState().status).toBe('recording');

        await waitForLocalVoiceState(state => state.status === 'transcribing');
        expect(getLocalVoiceState().status).toBe('transcribing');
        emitSpeechRecEvent('end', {});

        await waitForLocalVoiceBoundaryEvent('pending-enqueue');
        expect(localVoicePendingEnqueue.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: 'timed hands free' },
            }) } }),
        }));
    });

    it('real capture owner forwards finalized device-STT endpoints to the runtime engine seam', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            handsFree: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });
        const endpointEntered = createDeferred<void>();
        const onEndpointSignal = vi.fn(() => endpointEntered.resolve());
        const { createLocalVoiceCaptureOwner } = await import('@/voice/runtime/input/LocalVoiceCaptureOwner');
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => storage.getState().settings,
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
                onEndpointSignal,
            },
            {
                createDeviceSttController,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 's1',
            signal: new AbortController().signal,
        });
        expect(audioStreamStart).not.toHaveBeenCalled();
        emitSpeechRecEvent('result', {
            isFinal: true,
            results: [{ transcript: 'hands free message', confidence: 0.9, segments: [] }],
        });

        await endpointEntered.promise;
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 's1',
                source: 'heuristic',
                transcript: 'hands free message',
        }));
        const stopCallCountBeforeEndpointStop = speechRecStop.mock.calls.length;
        await expect(owner.stopEndpointDrivenCapture({
            adaptiveConfig: { ignoredPhrases: [] },
            provider: 'device',
            sessionId: 's1',
        })).resolves.toEqual({
            followUp: {
                kind: 'rearm_capture',
                provider: 'device',
                sessionId: 's1',
            },
            kind: 'submit_turn',
            transcript: 'hands free message',
        });
        expect(speechRecStop.mock.calls.length).toBeGreaterThan(stopCallCountBeforeEndpointStop);
        await owner.stopSession();
    });


});

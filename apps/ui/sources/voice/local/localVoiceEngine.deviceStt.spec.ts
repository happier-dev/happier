import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    audioStreamStart,
    expoSpeechSpeak,
    expoSpeechStop,
    emitSpeechRecEvent,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    setPlatformOs,
    speechRecAbort,
    speechRecStart,
    speechRecStop,
    speechRecRequestPermissionsAsync,
    submitMessage,
} from './localVoiceEngine.testHarness';

type CallCountSpy = {
    mock: {
        calls: unknown[][];
    };
};

const waitForCallCount = async (spy: CallCountSpy, expectedCount: number) => {
    await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(expectedCount);
    });
};

async function configureDuplexDeviceSpeech(handsFree: boolean) {
    speechRecStart.mockImplementation(() => {
        emitSpeechRecEvent('start');
        emitSpeechRecEvent('audiostart');
    });
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
                    handsFree: { ...config.handsFree, enabled: handsFree,
                        endpointing: { silenceMs: 0, minSpeechMs: 0 } },
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

    it.each(['direct interruption', 'after a backchannel', 'manual capture'])(
      'captures a second utterance through the real recognizer while an ordinary spoken reply is held (%s)', async (scenario) => {
        const storage = await configureDuplexDeviceSpeech(scenario !== 'manual capture');
        let finishSpeech: (() => void) | undefined;
        expoSpeechSpeak.mockImplementation((_text, options) => {
            finishSpeech = options.onStopped;
            options.onStart?.();
        });
        expoSpeechStop.mockImplementation(() => finishSpeech?.());
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        submitMessage.mockImplementationOnce(() => {
            storage.__setState({ sessionMessages: { s1: { messages: [
                { id: 'reply-one', kind: 'agent-text', text: 'The weather will be sunny tomorrow.', createdAt: Date.now() + 60_000 },
            ] } } });
            storage.__notify();
        });
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'what is the forecast', confidence: 0.9 }] });
        const initialTurn = scenario === 'manual capture' ? engine.toggleLocalVoiceTurn('s1') : Promise.resolve();
        await vi.waitFor(() => expect(engine.getLocalVoiceState().status).toBe('speaking'));
        // Capture is live again before the held output finishes, using the actual
        // capture owner and recognizer controller rather than injected endpoints.
        expect(speechRecStart.mock.calls.length).toBe(2);
        await new Promise((resolve) => setTimeout(resolve, 850));
        if (scenario === 'after a backchannel') {
            const playbackStops = expoSpeechStop.mock.calls.length;
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'yeah', confidence: 0.9 }] });
            await waitForCallCount(speechRecStart, 3);
            expect(expoSpeechStop.mock.calls.length).toBe(playbackStops);
            expect(submitMessage).toHaveBeenCalledTimes(1);
        }
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'instead explain the wind speed', confidence: 0.9 }] });
        await vi.waitFor(() => expect(expoSpeechStop).toHaveBeenCalled());
        await vi.waitFor(() => expect(submitMessage).toHaveBeenCalledWith('s1', 'instead explain the wind speed', undefined, undefined, {
            callerSurface: 'voice_turn', forceImmediate: true, hostAdmissionOrigin: 'voice',
        }));
        await initialTurn;
        await engine.stopLocalVoiceSession();
    }, 180_000);

    it('releases the playback capture when the recognized turn fails to send', async () => {
        await configureDuplexDeviceSpeech(false);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const failure = new Error('network_send_failed');
        submitMessage.mockRejectedValueOnce(failure);
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

    it('does not submit a late turn when End Voice cancels playback capture startup', async () => {
        const storage = await configureDuplexDeviceSpeech(false);
        const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
        let resolvePermission!: (result: { granted: boolean; canAskAgain: boolean }) => void;
        const delayedPermission = new Promise<{ granted: boolean; canAskAgain: boolean }>((resolve) => { resolvePermission = resolve; });
        vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: true, canAskAgain: true });
        vi.mocked(requestMicrophonePermission).mockImplementationOnce(() => delayedPermission);
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        expoSpeechSpeak.mockImplementation((_text, options) => options.onDone?.());
        submitMessage.mockImplementationOnce(() => {
            storage.__setState({ sessionMessages: { s1: { messages: [
                { id: 'late-reply', kind: 'agent-text', text: 'This should not be sent.', createdAt: Date.now() + 60_000 },
            ] } } });
            storage.__notify();
        });
        const engine = await loadLocalVoiceEngineWithCompatState();
        await engine.toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'explain the forecast', confidence: 0.9 }] });
        const turn = engine.toggleLocalVoiceTurn('s1');
        await waitForCallCount(vi.mocked(requestMicrophonePermission), 2);
        const end = engine.stopLocalVoiceSession();
        resolvePermission({ granted: true, canAskAgain: true });
        await Promise.all([turn, end]);
        expect(submitMessage).not.toHaveBeenCalled();
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

    it('surfaces mic permission denial as a recoverable idle error instead of entering recording', async () => {
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
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
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
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

    it('supports provider-based device STT settings', async () => {
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                autoSpeakReplies: false,
                            },
                        } },
                    },
                },
            },
        });

        const { resolveLocalSttProvider } = await import('./localVoiceSettings');
        expect(resolveLocalSttProvider(storage.getState().settings)).toBe('device');

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalled();
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
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

        await vi.waitFor(() => {
            expect(getLocalVoiceState()).toEqual({
                status: 'idle',
                sessionId: 's1',
                error: 'device_stt_error',
            });
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
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

        expect(submitMessage).toHaveBeenCalledWith('s1', 'hello from device stt', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
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
                                ...storage.getState().settings.voice.providers.local_direct.config,
                                stt: {
                                    ...storage.getState().settings.voice.providers.local_direct.config.stt,
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
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
        await vi.waitFor(() => {
            expect(getLocalVoiceState().status).toBe('transcribing');
        });
        emitSpeechRecEvent('end', {});

        await waitForCallCount(submitMessage, 1);
        await waitForCallCount(speechRecStart, 2);
        expect(submitMessage).toHaveBeenCalledWith('s1', 'hands free message', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('rearms hands-free listening when the endpointed transcript is only a backchannel', async () => {
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
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
        await waitForCallCount(speechRecStop, 1);
        emitSpeechRecEvent('end', {});

        await vi.waitFor(() => {
            expect(submitMessage).not.toHaveBeenCalled();
            expect(speechRecStart).toHaveBeenCalledTimes(2);
            expect(getLocalVoiceState().status).toBe('recording');
        });
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
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

        await vi.waitFor(() => {
            expect(getLocalVoiceState().status).toBe('transcribing');
        });
        emitSpeechRecEvent('end', {});

        await waitForCallCount(submitMessage, 1);
        expect(submitMessage).toHaveBeenCalledWith('s1', 'timed hands free', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });
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
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        } },
                    },
                },
            },
        });
        const onEndpointSignal = vi.fn();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
            getAudioContext: vi.fn(() => null),
        };
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
                createLiveMicSession: () => liveMicSession as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 's1',
            signal: new AbortController().signal,
        });
        expect(liveMicSession.ensureActive).not.toHaveBeenCalled();
        expect(audioStreamStart).not.toHaveBeenCalled();
        emitSpeechRecEvent('result', {
            isFinal: true,
            results: [{ transcript: 'hands free message', confidence: 0.9, segments: [] }],
        });

        await vi.waitFor(() => {
            expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 's1',
                source: 'heuristic',
                transcript: 'hands free message',
            }));
        });
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

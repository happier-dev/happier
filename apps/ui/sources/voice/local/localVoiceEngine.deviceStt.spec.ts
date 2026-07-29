import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    audioStreamStart,
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
import type { TurnEndpointSignal } from '@/voice/runtime/input/TurnEndpointController';

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

describe('local voice engine device STT (experimental)', () => {
    registerLocalVoiceEngineHarnessHooks();
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

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
        const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
        vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: false, canAskAgain: false });

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
                                provider: 'device',
                                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                                googleGemini: { apiKey: null, model: 'gemini-2.0-flash-lite', language: null },
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
                                provider: 'device',
                                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                                googleGemini: { apiKey: null, model: 'gemini-2.0-flash-lite', language: null },
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

        const previousWindow = (globalThis as any).window;
        const previousDocument = (globalThis as any).document;
        (globalThis as any).window = {};
        (globalThis as any).document = {};

        try {
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
                                    useDeviceStt: true,
                                    baseUrl: null,
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
                                useDeviceStt: true,
                                baseUrl: null,
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
        });
    });

    it('routes runtime-owned hands-free endpoint signals through the capture-owner active-session gate', async () => {
        const endpointSignalHarness: {
            emit: ((signal: TurnEndpointSignal) => void) | null;
        } = { emit: null };
        const startCapture = vi.fn(async () => {});
        const stopEndpointDrivenCapture = vi.fn(async () => ({
            followUp: { kind: 'none' as const },
            kind: 'submit_turn' as const,
            transcript: 'hands free message',
        }));
        const resolveEndpointSignalAction = vi.fn((args: { signal: { sessionId: string } }) => ({
            kind: 'stop_capture' as const,
            provider: 'device' as const,
            sessionId: args.signal.sessionId,
        }));
        const isHandsFreeCaptureSession = vi.fn(() => true);

        vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
            createLocalVoiceCaptureOwner: (deps: {
                onEndpointSignal?: (signal: TurnEndpointSignal) => void;
            }) => {
                endpointSignalHarness.emit = (signal) => deps.onEndpointSignal?.(signal);
                return {
                    resolveManualBargeInAction: vi.fn(() => ({
                        kind: 'noop',
                        reason: 'not_speaking',
                    })),
                    resolveEndpointSignalAction,
                    startCapture,
                    stopCapture: vi.fn(async () => ({
                        continueHandsFree: false,
                        provider: 'device',
                        text: '',
                    })),
                    stopEndpointDrivenCapture,
                    isHandsFreeCaptureSession,
                    clearHandsFree: vi.fn(),
                    setMuted: vi.fn(async () => {}),
                    stopSession: vi.fn(async () => {}),
                };
            },
        }));

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

        const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'device',
            sessionId: 's1',
            signal: expect.any(Object),
        }));

        endpointSignalHarness.emit?.({
            detectedAt: Date.now(),
            endpoint: { reason: 'structural_fallback', confidence: null },
            sessionId: 's1',
            source: 'heuristic',
            transcript: 'hands free message',
        });

        await waitForCallCount(stopEndpointDrivenCapture as unknown as CallCountSpy, 1);
        expect(isHandsFreeCaptureSession).toHaveBeenCalledWith({ provider: 'device', sessionId: 's1' });
        expect(resolveEndpointSignalAction).toHaveBeenCalledWith(expect.objectContaining({
            currentSessionId: 's1',
            currentStatus: 'recording',
            handsFreeEnabled: true,
            inFlight: false,
            provider: 'device',
        }));
        expect(submitMessage).toHaveBeenCalledWith('s1', 'hands free message', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
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
    });

    it('delegates device STT ownership to LocalVoiceCaptureOwner instead of constructing the device controller in localVoiceEngine', async () => {
        const startCapture = vi.fn(async () => {});

        vi.doMock('@/voice/input/DeviceSttController', () => ({
            createDeviceSttController: () => {
                throw new Error('localVoiceEngine should not create DeviceSttController directly');
            },
        }));
        vi.doMock('@/voice/runtime/input/createRuntimeTurnPolicyController', () => ({
            createRuntimeTurnPolicyController: () => {
                throw new Error('localVoiceEngine should not create runtime turn policy controllers directly');
            },
        }));
        vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
            createLocalVoiceCaptureOwner: () => ({
                resolveManualBargeInAction: vi.fn(() => ({
                    kind: 'noop',
                    reason: 'not_speaking',
                })),
                resolveEndpointSignalAction: vi.fn(() => ({
                    kind: 'ignore',
                    reason: 'not_hands_free',
                })),
                startCapture,
                stopCapture: vi.fn(async () => ({
                    provider: 'device',
                    text: '',
                    continueHandsFree: false,
                })),
                stopEndpointDrivenCapture: vi.fn(async () => ({
                    kind: 'ignore',
                    reason: 'empty_transcript',
                    shouldRearm: false,
                })),
                isHandsFreeCaptureSession: vi.fn(() => false),
                clearHandsFree: vi.fn(),
                stopSession: vi.fn(async () => {}),
            }),
        }));

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
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            provider: 'device',
            signal: expect.any(Object),
        }));
        expect(getLocalVoiceState().status).toBe('recording');
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    emitSpeechRecEvent,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    setPlatformOs,
    speechRecAbort,
    speechRecStart,
    speechRecStop,
    speechRecRequestPermissionsAsync,
} from './localVoiceEngine.testHarness';

const webVadState = vi.hoisted(() => ({
    onSpeechEnd: null as null | (() => void),
}));

vi.mock('@ricky0123/vad-web', () => ({
    MicVAD: {
        new: vi.fn(async (options: { onSpeechEnd?: () => void }) => {
            webVadState.onSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
            return {
                pause: vi.fn(),
                start: vi.fn(),
            };
        }),
    },
}));

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

    it('surfaces mic permission denial as an error instead of entering recording', async () => {
        const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
        vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: false, canAskAgain: false });

        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                provider: 'device',
                                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                                googleGemini: { apiKey: null, model: 'gemini-2.0-flash-lite', language: null },
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(speechRecStart).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'error',
            sessionId: 's1',
            error: 'mic_permission_denied',
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                provider: 'device',
                                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                                googleGemini: { apiKey: null, model: 'gemini-2.0-flash-lite', language: null },
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                        },
                    },
                },
            },
        });

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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                        },
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

        expect(sendMessage).toHaveBeenCalledWith('s1', 'hello from device stt');
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                        },
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
                        adapters: {
                            ...storage.getState().settings.voice.adapters,
                            local_direct: {
                                ...storage.getState().settings.voice.adapters.local_direct,
                                stt: {
                                    ...storage.getState().settings.voice.adapters.local_direct.stt,
                                    useDeviceStt: true,
                                    baseUrl: null,
                                },
                            },
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(1);

        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'hands free message', confidence: 0.9, segments: [] }] });
        await waitForCallCount(speechRecStop, 1);
        expect(speechRecStop).toHaveBeenCalledTimes(1);
        emitSpeechRecEvent('end', {});

        await waitForCallCount(sendMessage, 1);
        await waitForCallCount(speechRecStart, 2);
        expect(sendMessage).toHaveBeenCalledWith('s1', 'hands free message');
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        },
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
            expect(sendMessage).not.toHaveBeenCalled();
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        const stopPromise = toggleLocalVoiceTurn('s1');
        expect(speechRecStop).toHaveBeenCalledTimes(1);
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 10, minSpeechMs: 0 },
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'timed hands free', confidence: 0.9, segments: [] }] });
        expect(speechRecStop).not.toHaveBeenCalled();

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(speechRecStop).not.toHaveBeenCalled();

        await waitForCallCount(speechRecStop, 1);
        expect(speechRecStop).toHaveBeenCalledTimes(1);
        emitSpeechRecEvent('end', {});

        await waitForCallCount(sendMessage, 1);
        expect(sendMessage).toHaveBeenCalledWith('s1', 'timed hands free');
    });

    it('uses web VAD endpoint signals to stop and rearm hands-free web capture', async () => {
        setPlatformOs('web');
        webVadState.onSpeechEnd = null;
        (globalThis as { window?: object }).window = {};
        (globalThis as { document?: object }).document = {};

        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: false,
                            },
                            handsFree: {
                                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                enabled: true,
                                endpointing: { silenceMs: 0, minSpeechMs: 0 },
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(1);

        emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: 'web vad message', confidence: 0.9, segments: [] }] });
        expect(speechRecStop).not.toHaveBeenCalled();

        const onSpeechEnd = webVadState.onSpeechEnd as null | (() => void);
        onSpeechEnd?.();

        await waitForCallCount(speechRecStop, 1);
        emitSpeechRecEvent('end', {});

        await waitForCallCount(sendMessage, 1);
        await waitForCallCount(speechRecStart, 2);
        expect(sendMessage).toHaveBeenCalledWith('s1', 'web vad message');
        expect(getLocalVoiceState().status).toBe('recording');
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
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            provider: 'device',
        }));
        expect(getLocalVoiceState().status).toBe('recording');
    });
});

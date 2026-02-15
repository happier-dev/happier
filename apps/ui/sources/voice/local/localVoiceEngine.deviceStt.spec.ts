import { describe, expect, it, vi } from 'vitest';

import {
    emitSpeechRecEvent,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    setPlatformOs,
    speechRecAbort,
    speechRecStart,
    speechRecStop,
    speechRecRequestPermissionsAsync,
} from './localVoiceEngine.testHarness';

describe('local voice engine device STT (experimental)', () => {
    registerLocalVoiceEngineHarnessHooks();

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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
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

            const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(1);

        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'hands free message', confidence: 0.9, segments: [] }] });
        for (let i = 0; i < 20; i += 1) {
            await Promise.resolve();
        }
        expect(speechRecStop).toHaveBeenCalledTimes(1);
        emitSpeechRecEvent('end', {});

        for (let i = 0; i < 200; i += 1) {
            await Promise.resolve();
        }

        expect(sendMessage).toHaveBeenCalledWith('s1', 'hands free message');
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
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
        vi.useFakeTimers();
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
                                tts: {
                                    ...storage.getState().settings.voice.adapters.local_direct.tts,
                                    autoSpeakReplies: false,
                                },
                                handsFree: {
                                    ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                                    enabled: true,
                                    endpointing: { silenceMs: 50, minSpeechMs: 0 },
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

            await vi.advanceTimersByTimeAsync(49);
            expect(speechRecStop).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(speechRecStop).toHaveBeenCalledTimes(1);
            emitSpeechRecEvent('end', {});
            await vi.runOnlyPendingTimersAsync();
            for (let i = 0; i < 50; i += 1) {
                await Promise.resolve();
            }
            expect(sendMessage).toHaveBeenCalledWith('s1', 'timed hands free');
        } finally {
            vi.useRealTimers();
        }
    });
});

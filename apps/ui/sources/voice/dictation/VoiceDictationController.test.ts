import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceDictationController } from './VoiceDictationController';

const ORIGINAL_PLATFORM_OS = Platform.OS;

const EXPECTED_DICTATION_LIMITS = {
    captureDurationMs: 60_000,
    transcriptionDeadlineMs: 30_000,
    transcriptCharacters: 8_000,
    transcriptUtf8Bytes: 16_000,
    recordedAudioBytes: 8 * 1024 * 1024,
} as const;

const TEST_RECORDED_AUDIO_BOUNDARY = {
    measureRecordedAudioBytes: async () => 4,
    deleteRecordedAudio: async () => {},
} as const;

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function createPendingCaptureStartHarness() {
    const startSettled = createDeferred();
    const teardownSettled = createDeferred();
    let observedSignal: AbortSignal | null = null;
    const rawCaptureOwner = {
        startCapture: vi.fn(async (args: { signal?: AbortSignal }) => {
            observedSignal = args.signal ?? null;
            if (rawCaptureOwner.startCapture.mock.calls.length === 1) {
                await startSettled.promise;
            }
        }),
        stopCapture: vi.fn(async () => {
            throw new Error('stop_capture_during_startup');
        }),
        stopSession: vi.fn(async () => {
            await startSettled.promise;
            await teardownSettled.promise;
        }),
    };
    const admission = createVoiceCaptureAdmissionController();
    const captureOwner = createVoiceCaptureAdmissionBinding({
        admission,
        captureOwner: rawCaptureOwner as never,
        productOwner: 'dictation',
    });
    const controller = createVoiceDictationController({
        captureOwner,
        ...TEST_RECORDED_AUDIO_BOUNDARY,
        getSettings: () => ({
            voice: {
                providerId: 'local_conversation',
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: { stt: { provider: 'device' } },
                    },
                },
            },
        }),
        transcribeRecordedAudio: vi.fn(),
    });
    return {
        admission,
        controller,
        getObservedSignal: () => observedSignal,
        rawCaptureOwner,
        startSettled,
        teardownSettled,
    };
}

afterEach(() => {
    vi.useRealTimers();
    (Platform as unknown as { OS: string }).OS = ORIGINAL_PLATFORM_OS;
});

describe('createVoiceDictationController', () => {
    it('uses explicit Dictation STT instead of silently inheriting conversational Voice', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const settings = {
            voice: {
                providerId: 'local_conversation',
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: { stt: { provider: 'device' } },
                    },
                },
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de-CH',
                    stt: {
                        provider: 'happier.voice.openai-compat/stt',
                    },
                },
            },
        };
        const transcribeRecordedAudio = vi.fn(async () => 'eigenständige Auswahl');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => settings,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'recorded_audio',
            settings: expect.objectContaining({
                voice: expect.objectContaining({
                    assistantLanguage: 'de-CH',
                    providerId: 'local_conversation',
                    providers: expect.objectContaining({
                        local_conversation: expect.objectContaining({
                            config: expect.objectContaining({
                                stt: expect.objectContaining({
                                    provider: 'happier.voice.openai-compat/stt',
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        }));
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'eigenständige Auswahl',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            settings: expect.objectContaining({
                voice: expect.objectContaining({
                    assistantLanguage: 'de-CH',
                }),
            }),
        }));
    });

    it('inherits Local Voice STT only through the visible same-as-local binding', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: 'bound local choice',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                    dictation: {
                        sttBinding: 'same_as_local',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'device',
        }));
    });

    it('re-resolves the persisted Dictation selection before every normal start', async () => {
        let provider: 'device' | 'happier.voice.openai-compat/stt' = 'device';
        const captureOwner = {
            startCapture: vi.fn(async (_request: { provider: string }) => {}),
            stopCapture: vi.fn(async (args: { provider: string }) => (
                args.provider === 'device'
                    ? {
                        provider: 'device' as const,
                        text: '',
                        continueHandsFree: false,
                    }
                    : {
                        provider: 'recorded_audio' as const,
                        uri: null,
                    }
            )),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await controller.toggle('session-1');
        provider = 'happier.voice.openai-compat/stt';
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });

        expect(captureOwner.startCapture.mock.calls.map(([request]) => request.provider))
            .toEqual(['device', 'recorded_audio']);
    });

    it('captures one utterance through the selected recorded-audio STT provider', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const transcribeRecordedAudio = vi.fn(async () => ' dictated text ');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(controller.getSnapshot()).toEqual({
            sessionId: 'session-1',
            status: 'listening',
        });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
            signal: expect.any(AbortSignal),
        }));

        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'dictated text',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            uri: 'file:///dictation.m4a',
            signal: expect.any(AbortSignal),
        }));
        await vi.waitFor(() => {
            expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        });
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it('surfaces a failed recorded-audio deletion without discarding the completed transcript', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation-retained.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {
            throw new Error('recording_delete_failed');
        });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: vi.fn(async () => 'usable transcript'),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'usable transcript',
        });

        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///dictation-retained.m4a');
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                sessionId: 'session-1',
                kind: 'provider_error',
                reason: 'capture_failed',
            },
        });
    });

    it('records web Auto local-neural Dictation before using the single-shot transcription owner', async () => {
        (Platform as unknown as { OS: string }).OS = 'web';
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///daemon-dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const transcribeRecordedAudio = vi.fn(async () => 'daemon transcript');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: {
                            provider: 'local_neural',
                            localNeural: {
                                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                                execution: 'auto',
                            },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'recorded_audio',
        }));

        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'daemon transcript',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            uri: 'file:///daemon-dictation.m4a',
        }));
    });

    it('pins the selected execution machine for the whole recorded-audio attempt', async () => {
        (Platform as unknown as { OS: string }).OS = 'web';
        let executionMachineId: string | null = 'machine-ready-at-start';
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///daemon-dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const transcribeRecordedAudio = vi.fn(async () => 'open the project settings');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        stt: {
                            provider: 'local_neural',
                            localNeural: {
                                assetId: 'dummy',
                                execution: 'auto',
                            },
                        },
                    },
                },
            }),
            resolveExecutionMachineId: () => executionMachineId,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        executionMachineId = null;
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'open the project settings',
        });

        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            executionMachineId: 'machine-ready-at-start',
        }));
    });

    it('returns streaming device text without creating a recorded-audio transcription', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: ' device transcript ',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(async () => {}),
        };
        const transcribeRecordedAudio = vi.fn();
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'device transcript',
        });
        expect(transcribeRecordedAudio).not.toHaveBeenCalled();
    });

    it('aborts and discards an in-flight transcription when its session is cancelled', async () => {
        let resolveTranscription: (value: string) => void = () => {};
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const transcribeRecordedAudio = vi.fn((params: { signal?: AbortSignal | null }) => (
            new Promise<string>((resolve) => {
                resolveTranscription = resolve;
                params.signal?.addEventListener('abort', () => resolve('late transcript'), { once: true });
            })
        ));
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        const completion = controller.toggle('session-1');
        await vi.waitFor(() => {
            expect(transcribeRecordedAudio).toHaveBeenCalledTimes(1);
        });

        await controller.cancel('session-1');
        resolveTranscription('late transcript');

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot().status).toBe('idle');
    });

    it('removes a recorded-audio artifact that settles after cancellation', async () => {
        let resolveStoppedCapture!: (result: Readonly<{
            provider: 'recorded_audio';
            uri: string;
        }>) => void;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(() => new Promise<Readonly<{
                provider: 'recorded_audio';
                uri: string;
            }>>((resolve) => {
                resolveStoppedCapture = resolve;
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        const completion = controller.toggle('session-1');
        await vi.waitFor(() => {
            expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);
        });

        await controller.cancel('session-1');
        resolveStoppedCapture({
            provider: 'recorded_audio',
            uri: 'file:///late-dictation.m4a',
        });

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///late-dictation.m4a');
    });

    it.each([
        ['native recording', 'file:///dictation-cancel-before-finish.m4a'],
        ['web Blob recording', 'blob:dictation-cancel-before-finish'],
    ] as const)('stops and cleans a %s before cancellation tears its recorder down', async (_surface, uri) => {
        if (uri.startsWith('blob:')) {
            (Platform as unknown as { OS: string }).OS = 'web';
        }
        let resolveStoppedCapture!: (result: Readonly<{
            provider: 'recorded_audio';
            uri: string;
        }>) => void;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(() => new Promise<Readonly<{
                provider: 'recorded_audio';
                uri: string;
            }>>((resolve) => {
                resolveStoppedCapture = resolve;
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        let cancellationSettled = false;
        const cancellation = controller.cancel('session-1').then(() => {
            cancellationSettled = true;
        });

        await vi.waitFor(() => {
            expect(captureOwner.stopCapture).toHaveBeenCalledOnce();
        });
        await vi.waitFor(() => {
            expect(cancellationSettled).toBe(true);
        });
        expect(captureOwner.stopSession).not.toHaveBeenCalled();

        resolveStoppedCapture({ provider: 'recorded_audio', uri });
        await cancellation;
        await vi.waitFor(() => {
            expect(deleteRecordedAudio).toHaveBeenCalledWith(uri);
            expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        });
    });

    it('cleans a cancelled recording before a pending session teardown while retaining capture admission', async () => {
        const teardown = createDeferred();
        const rawCaptureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation-pending-teardown.m4a',
            })),
            stopSession: vi.fn(async () => {
                await teardown.promise;
            }),
        };
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner as never,
            productOwner: 'dictation',
        });
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: vi.fn(),
        });

        try {
            await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
            await controller.cancel('session-1');

            await vi.waitFor(() => {
                expect(deleteRecordedAudio).toHaveBeenCalledWith(
                    'file:///dictation-pending-teardown.m4a',
                );
                expect(rawCaptureOwner.stopSession).toHaveBeenCalledWith('session-1');
            });

            // stopCapture has finalized the recording, but the capture binding
            // correctly retains its lease until its owner-local session teardown
            // settles. A retry must not race an old teardown into a new capture.
            expect(admission.acquire('conversation')).toMatchObject({
                status: 'busy',
                activeOwner: 'dictation',
            });
            let retrySettled = false;
            const retry = controller.toggle('session-1').then((result) => {
                retrySettled = true;
                return result;
            });
            await Promise.resolve();
            expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
            expect(retrySettled).toBe(false);

            teardown.resolve();
            await expect(retry).resolves.toEqual({ kind: 'started' });
        } finally {
            teardown.resolve();
        }
    });

    it('starts only one same-session retry after simultaneous waiters release a cancelled teardown', async () => {
        const teardown = createDeferred();
        const rawCaptureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation-simultaneous-retry.m4a',
            })),
            stopSession: vi.fn(async () => {
                await teardown.promise;
            }),
        };
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner as never,
            productOwner: 'dictation',
        });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio: vi.fn(async () => {}),
            transcribeRecordedAudio: vi.fn(),
        });

        try {
            await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
            await controller.cancel('session-1');
            await vi.waitFor(() => {
                expect(rawCaptureOwner.stopSession).toHaveBeenCalledWith('session-1');
            });

            const firstRetry = controller.toggle('session-1');
            const secondRetry = controller.toggle('session-1');
            await Promise.resolve();
            expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);

            teardown.resolve();

            await expect(firstRetry).resolves.toEqual({ kind: 'started' });
            await expect(secondRetry).resolves.toEqual({ kind: 'cancelled' });
            expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(2);
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
            expect(controller.getSnapshot()).toEqual({
                sessionId: 'session-1',
                status: 'listening',
            });
        } finally {
            teardown.resolve();
            await controller.cancel('session-1');
        }
    });

    it('waits for prompt cancellation cleanup before restarting the same Dictation session', async () => {
        let resolveStoppedCapture!: (result: Readonly<{
            provider: 'recorded_audio';
            uri: string;
        }>) => void;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(() => new Promise<Readonly<{
                provider: 'recorded_audio';
                uri: string;
            }>>((resolve) => {
                resolveStoppedCapture = resolve;
            })),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio: vi.fn(async () => {}),
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await controller.cancel('session-1');
        const retry = controller.toggle('session-1');
        await Promise.resolve();
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);

        resolveStoppedCapture({
            provider: 'recorded_audio',
            uri: 'file:///dictation-retry-after-cancel.m4a',
        });

        await expect(retry).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('treats End Dictation during capture startup as cancellation', async () => {
        let resolveStart: () => void = () => {};
        const captureOwner = {
            startCapture: vi.fn(() => new Promise<void>((resolve) => {
                resolveStart = resolve;
            })),
            stopCapture: vi.fn(),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        const starting = controller.toggle('session-1');
        await vi.waitFor(() => {
            expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);
        });
        const ending = controller.toggle('session-1');
        resolveStart();

        await expect(ending).resolves.toEqual({ kind: 'cancelled' });
        await expect(starting).resolves.toEqual({ kind: 'cancelled' });
        expect(captureOwner.stopCapture).not.toHaveBeenCalled();
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot().status).toBe('idle');
    });

    it('settles a pending capture start at the deadline while retaining admission through teardown', async () => {
        vi.useFakeTimers();
        const harness = createPendingCaptureStartHarness();
        let startResult: unknown;
        let startFinished = false;

        void harness.controller.toggle('session-1').then((result) => {
            startResult = result;
            startFinished = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
        expect(harness.getObservedSignal()?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.captureDurationMs);
        expect(harness.controller.getSnapshot()).toEqual({
            sessionId: 'session-1',
            status: 'starting',
        });

        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(startFinished).toBe(true);
        expect(startResult).toEqual({ kind: 'cancelled' });
        expect(harness.getObservedSignal()?.aborted).toBe(true);
        expect(harness.controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                kind: 'stt_timeout',
                reason: 'capture_start_deadline_exceeded',
                sessionId: 'session-1',
            },
        });
        expect(harness.rawCaptureOwner.stopCapture).not.toHaveBeenCalled();
        expect(harness.rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(harness.admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });
        let earlyRetryResult: unknown;
        let earlyRetryFinished = false;
        void harness.controller.toggle('session-1').then((result) => {
            earlyRetryResult = result;
            earlyRetryFinished = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(earlyRetryFinished).toBe(true);
        expect(earlyRetryResult).toEqual({ kind: 'cancelled' });
        expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
        expect(harness.admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        harness.startSettled.resolve();
        await Promise.resolve();
        expect(harness.admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        harness.teardownSettled.resolve();
        await harness.rawCaptureOwner.stopSession.mock.results[0]?.value;
        await vi.waitFor(async () => {
            await expect(harness.controller.toggle('session-1')).resolves.toEqual({
                kind: 'started',
            });
        });
        expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(2);
        await harness.controller.cancel('session-1');
    });

    it('aborts an uncooperative capture start before cancellation settles after teardown', async () => {
        const harness = createPendingCaptureStartHarness();
        let startResult: unknown;
        let startFinished = false;
        const starting = harness.controller.toggle('session-1').then((result) => {
            startResult = result;
            startFinished = true;
        });
        await vi.waitFor(() => {
            expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
        });

        let cancelSettlementCount = 0;
        const cancellation = harness.controller.cancel('session-1').then(() => {
            cancelSettlementCount += 1;
        });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(cancelSettlementCount).toBe(0);
        expect(startFinished).toBe(true);
        expect(startResult).toEqual({ kind: 'cancelled' });
        expect(harness.getObservedSignal()?.aborted).toBe(true);
        expect(harness.controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
        expect(harness.rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(harness.admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        harness.startSettled.resolve();
        harness.teardownSettled.resolve();
        await harness.rawCaptureOwner.stopSession.mock.results[0]?.value;
        await Promise.all([starting, cancellation]);
        expect(cancelSettlementCount).toBe(1);
        await vi.waitFor(async () => {
            await expect(harness.controller.toggle('session-1')).resolves.toEqual({
                kind: 'started',
            });
        });
        expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(2);
        await harness.controller.cancel('session-1');
    });

    it('waits for cross-session teardown to release admission before starting the next session', async () => {
        const teardownSettled = createDeferred();
        const rawCaptureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: '',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(async () => {
                await teardownSettled.promise;
            }),
        };
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-a')).resolves.toEqual({ kind: 'started' });

        let switchSettled = false;
        const switching = controller.toggle('session-b').then(
            (result) => ({ status: 'resolved' as const, result }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
        ).then((outcome) => {
            switchSettled = true;
            return outcome;
        });
        await vi.waitFor(() => {
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
        });

        expect(switchSettled).toBe(false);
        expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        teardownSettled.resolve();

        await expect(switching).resolves.toEqual({
            status: 'resolved',
            result: { kind: 'started' },
        });
        expect(rawCaptureOwner.startCapture).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ sessionId: 'session-b' }),
        );
        expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
        await controller.cancel('session-b');
    });

    it('projects capture-owner failure separately from silent cancellation', async () => {
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: '',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        controller.reportCaptureError({
            controlSessionId: 'session-1',
            kind: 'provider_error',
            reason: 'device_stt_unavailable',
        });

        await vi.waitFor(() => {
            expect(controller.getSnapshot()).toMatchObject({
                sessionId: null,
                status: 'idle',
                failure: {
                    id: 1,
                    sessionId: 'session-1',
                    kind: 'provider_error',
                    reason: 'provider_unavailable',
                },
            });
        });
        await vi.waitFor(() => {
            expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        });

        controller.dismissFailure(1);
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it('does not start a retry until failed capture cleanup has completed', async () => {
        let resolveCleanup: () => void = () => {};
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: '',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(() => new Promise<void>((resolve) => {
                resolveCleanup = resolve;
            })),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: vi.fn(),
        });

        await controller.toggle('session-1');
        controller.reportCaptureError({
            controlSessionId: 'session-1',
            kind: 'provider_error',
            reason: 'device_stt_unavailable',
        });
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'cancelled',
        });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);

        await vi.waitFor(() => {
            expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        });
        resolveCleanup();
        await vi.waitFor(async () => {
            await expect(controller.toggle('session-1')).resolves.toEqual({
                kind: 'started',
            });
        });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('allows capture at the exact duration limit and fails at limit + 1 with one bounded teardown', async () => {
        vi.useFakeTimers();
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const measureRecordedAudioBytes = vi.fn(async () => 4);
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = vi.fn(async () => 'must not be inserted');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes,
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.captureDurationMs);
        expect(controller.getSnapshot()).toEqual({
            sessionId: 'session-1',
            status: 'listening',
        });

        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => {
            expect(controller.getSnapshot()).toMatchObject({
                sessionId: null,
                status: 'idle',
                failure: {
                    kind: 'stt_timeout',
                    reason: 'capture_duration_exceeded',
                    sessionId: 'session-1',
                },
            });
        });

        expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(measureRecordedAudioBytes).not.toHaveBeenCalled();
        expect(transcribeRecordedAudio).not.toHaveBeenCalled();
        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///dictation.m4a');

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('bounds a pending provider transcription and settles a simultaneous navigation cancel once', async () => {
        vi.useFakeTimers();
        let transcriptionSignal: AbortSignal | null = null;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: vi.fn((params) => {
                transcriptionSignal = params.signal ?? null;
                return new Promise<string>(() => {});
            }),
        });

        await controller.toggle('session-1');
        const completion = controller.toggle('session-1');
        await vi.advanceTimersByTimeAsync(0);
        expect(transcriptionSignal).not.toBeNull();
        await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.transcriptionDeadlineMs);
        expect(controller.getSnapshot().status).toBe('transcribing');

        const navigationCancel = controller.cancel('session-1');
        await vi.advanceTimersByTimeAsync(1);
        await navigationCancel;

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect((transcriptionSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot().status).toBe('idle');

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('bounds recorder finalization from the stop request and still cleans a late recording', async () => {
        vi.useFakeTimers();
        let resolveStoppedCapture!: (result: Readonly<{
            provider: 'recorded_audio';
            uri: string;
        }>) => void;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(() => new Promise<Readonly<{
                provider: 'recorded_audio';
                uri: string;
            }>>((resolve) => {
                resolveStoppedCapture = resolve;
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = vi.fn(async () => 'must not start before finalization');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        let completionResult: unknown;
        let completionSettled = false;
        const completion = controller.toggle('session-1').then((result) => {
            completionResult = result;
            completionSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(captureOwner.stopCapture).toHaveBeenCalledOnce();

        try {
            await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.transcriptionDeadlineMs);
            expect(completionSettled).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            expect(completionSettled).toBe(true);
            expect(completionResult).toEqual({ kind: 'cancelled' });
            expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
                signal: expect.objectContaining({ aborted: true }),
            }));
            expect(controller.getSnapshot()).toMatchObject({
                sessionId: null,
                status: 'idle',
                failure: {
                    kind: 'stt_timeout',
                    reason: 'transcription_deadline_exceeded',
                },
            });
            expect(deleteRecordedAudio).not.toHaveBeenCalled();
            expect(captureOwner.stopSession).not.toHaveBeenCalled();
            expect(transcribeRecordedAudio).not.toHaveBeenCalled();
        } finally {
            resolveStoppedCapture({
                provider: 'recorded_audio',
                uri: 'file:///late-dictation-after-deadline.m4a',
            });
            await completion;
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(deleteRecordedAudio).toHaveBeenCalledWith(
            'file:///late-dictation-after-deadline.m4a',
        );
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
    });

    it('reports a typed transcription deadline when the provider remains pending', async () => {
        vi.useFakeTimers();
        let transcriptionSignal: AbortSignal | null = null;
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: 'file:///dictation.m4a',
            })),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio: vi.fn(async () => {}),
            transcribeRecordedAudio: vi.fn((params) => {
                transcriptionSignal = params.signal ?? null;
                return new Promise<string>(() => {});
            }),
        });

        await controller.toggle('session-1');
        const completion = controller.toggle('session-1');
        await vi.advanceTimersByTimeAsync(0);
        expect(transcriptionSignal).not.toBeNull();

        await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.transcriptionDeadlineMs);
        expect(controller.getSnapshot().status).toBe('transcribing');
        await vi.advanceTimersByTimeAsync(1);

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect((transcriptionSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                kind: 'stt_timeout',
                reason: 'transcription_deadline_exceeded',
            },
        });
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            label: 'character',
            exact: 'a'.repeat(EXPECTED_DICTATION_LIMITS.transcriptCharacters),
            over: 'a'.repeat(EXPECTED_DICTATION_LIMITS.transcriptCharacters + 1),
            reason: 'transcript_character_limit_exceeded',
        },
        {
            label: 'UTF-8 byte',
            exact: '😀'.repeat(EXPECTED_DICTATION_LIMITS.transcriptUtf8Bytes / 4),
            over: `${'😀'.repeat(EXPECTED_DICTATION_LIMITS.transcriptUtf8Bytes / 4)}a`,
            reason: 'transcript_utf8_limit_exceeded',
        },
    ])('accepts the exact $label transcript limit and rejects limit + 1', async ({
        exact,
        over,
        reason,
    }) => {
        const transcripts = [exact, over];
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'device' as const,
                text: transcripts.shift() ?? '',
                continueHandsFree: false,
            })),
            stopSession: vi.fn(async () => {}),
        };
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(),
            deleteRecordedAudio: vi.fn(),
            transcribeRecordedAudio: vi.fn(),
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: exact,
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                kind: 'provider_error',
                reason,
            },
        });
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(2);
    });

    it('accepts the exact recorded-payload limit, rejects limit + 1, and removes both temporary recordings', async () => {
        const sizes = [
            EXPECTED_DICTATION_LIMITS.recordedAudioBytes,
            EXPECTED_DICTATION_LIMITS.recordedAudioBytes + 1,
        ];
        const captureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(async () => ({
                provider: 'recorded_audio' as const,
                uri: `file:///dictation-${sizes.length}.m4a`,
            })),
            stopSession: vi.fn(async () => {}),
        };
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = vi.fn(async () => 'bounded text');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => sizes.shift() ?? null),
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'bounded text',
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(transcribeRecordedAudio).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(2);
        expect(controller.getSnapshot()).toMatchObject({
            failure: {
                kind: 'provider_error',
                reason: 'recorded_audio_limit_exceeded',
            },
        });
    });
});

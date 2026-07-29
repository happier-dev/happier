import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    VoiceAudioSessionPlatform,
    VoicePcmCapture,
    VoicePcmCaptureLease,
} from '@happier-dev/audio-stream-native';
import type {
    HappierAudioStreamNativeModule,
} from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';

import { createDaemonStreamingSttController } from '../daemonInference/DaemonStreamingSttController';
import type { DaemonSpeechPcmCaptureOptions } from '../daemonInference/DaemonSpeechPcmCapture';
import { createLocalVoiceCaptureOwner } from './LocalVoiceCaptureOwner';
import { resolveNativeSileroVadBridge } from './NativeSileroVadBridge';
import { createNativeVadController } from './NativeVadController';
import type { TurnEndpointSignal } from './TurnEndpointController';
import { createVoiceCaptureAdmissionBinding } from './VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from './VoiceCaptureAdmissionController';
import { createVoiceAudioSessionCoordinator } from '../../../../../../packages/audio-stream-native/src/voiceAudioSessionCoordinator';
import { createVoicePcmCapture } from '../../../../../../packages/audio-stream-native/src/voicePcmCapture';

const micVadNew = vi.fn();
const micVadStart = vi.fn();
const micVadPause = vi.fn();
let activeOnSpeechEnd: (() => void) | null = null;
let activeOnSpeechStart: (() => void) | null = null;

vi.mock('@ricky0123/vad-web', () => ({
    MicVAD: {
        new: (...args: unknown[]) => micVadNew(...args),
    },
}));

// WebVadController is platform-split for Metro (`WebVadController.ts` is the
// native-safe no-op fallback that keeps `@ricky0123/vad-web` -> `onnxruntime-web`
// out of the native bundle; `WebVadController.web.ts` holds the real
// implementation this suite exercises via the `@ricky0123/vad-web` mock above).
// Vitest has no Metro-style platform resolution for the unsuffixed import
// `LocalVoiceCaptureOwner.ts` uses, so point it at the real web implementation —
// its own `isDomRuntime()` guard still gates behavior identically to before the
// split when `window`/`document` are not simulated by a given test.
vi.mock('@/voice/runtime/input/WebVadController', () => import('./WebVadController.web'));

function requireObservedSttSignal(signal: AbortSignal | null): AbortSignal {
    if (!signal) {
        throw new Error('stt_signal_missing');
    }
    return signal;
}

function requireDaemonCaptureOptions(
    options: DaemonSpeechPcmCaptureOptions | null,
): DaemonSpeechPcmCaptureOptions {
    if (!options) {
        throw new Error('daemon_capture_options_missing');
    }
    return options;
}

function requireObservedSttErrorSink(sink: {
    onError: (failure: { kind: 'mic_ended'; reason: string }) => void;
} | null): {
    onError: (failure: { kind: 'mic_ended'; reason: string }) => void;
} {
    if (!sink) {
        throw new Error('stt_sink_missing');
    }
    return sink;
}

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

function createSharedNativePcmHarness(options: Readonly<{
    nativeStart?: HappierAudioStreamNativeModule['start'];
}> = {}): Readonly<{
    capture: VoicePcmCapture;
    emitFrame: (pcm16leBase64?: string) => void;
    nativeStart: ReturnType<typeof vi.fn>;
    nativeStop: ReturnType<typeof vi.fn>;
    platformApply: ReturnType<typeof vi.fn>;
    platformRestore: ReturnType<typeof vi.fn>;
}> {
    let onAudioFrame: ((event: Readonly<{
        channels: number;
        pcm16leBase64: string;
        sampleRate: number;
        streamId: string;
    }>) => void) | null = null;
    const nativeStart = vi.fn(
        options.nativeStart ?? (async () => ({ streamId: 'shared-native-stream' })),
    );
    const nativeStop = vi.fn(async () => {});
    const nativeModule: HappierAudioStreamNativeModule = {
        addListener: (eventName, listener) => {
            if (eventName === 'audioFrame') {
                onAudioFrame = listener as typeof onAudioFrame;
            }
            return {
                remove: () => {
                    onAudioFrame = null;
                },
            };
        },
        configureAudioSession: vi.fn(async (request) => ({
            generation: request.generation,
            aecAvailable: true,
            aecActive: true,
            route: 'speaker',
        })),
        restoreAudioSession: vi.fn(async () => {}),
        start: nativeStart,
        stop: nativeStop,
    };
    const platformApply = vi.fn(async (request) => ({
        generation: request.generation,
        aecAvailable: true,
        aecActive: true,
        route: 'speaker',
    }));
    const platformRestore = vi.fn(async () => {});
    const platform: VoiceAudioSessionPlatform = {
        apply: platformApply,
        restore: platformRestore,
    };
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const capture = createVoicePcmCapture({
        audioSessionCoordinator: coordinator,
        nativeModule,
    });

    return {
        capture,
        emitFrame: (pcm16leBase64 = 'AAE=') => {
            onAudioFrame?.({
                channels: 1,
                pcm16leBase64,
                sampleRate: 16_000,
                streamId: 'shared-native-stream',
            });
        },
        nativeStart,
        nativeStop,
        platformApply,
        platformRestore,
    };
}

function createSharedPcmSherpaController(capture: VoicePcmCapture): Readonly<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
}> {
    let lease: VoicePcmCaptureLease | null = null;
    let transcript = '';
    return {
        start: vi.fn(async ({ sessionId, sink, signal }) => {
            lease = await capture.acquire({
                ownerId: `sherpa-owner-test:${sessionId}`,
                format: { sampleRate: 16_000, channels: 1, frameMs: 20 },
                audioSession: {
                    mode: 'conversation',
                    input: true,
                    output: true,
                    aec: 'preferred',
                },
                shouldDeliver: () => !signal.aborted,
                onFrame: () => {
                    transcript = 'interrupt that';
                    sink.onAudioStarted();
                    sink.onPartial(transcript);
                },
            });
        }),
        stop: vi.fn(async () => {
            const activeLease = lease;
            lease = null;
            await activeLease?.release();
            await activeLease?.waitForDrain();
            return { finalText: transcript };
        }),
    };
}

describe('createLocalVoiceCaptureOwner', () => {
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

    beforeEach(() => {
        micVadNew.mockReset();
        micVadStart.mockReset();
        micVadPause.mockReset();
        activeOnSpeechEnd = null;
        activeOnSpeechStart = null;
        micVadNew.mockImplementation(async (options: { onSpeechEnd?: () => void; onSpeechStart?: () => void }) => {
            activeOnSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
            activeOnSpeechStart = typeof options.onSpeechStart === 'function' ? options.onSpeechStart : null;
            return {
                start: micVadStart,
                pause: micVadPause,
            };
        });
    });

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

    it('keeps hands-free session ownership in the runtime capture owner instead of the provider controllers', async () => {
        const deviceController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: 'device transcript' })),
        };
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: 'local neural transcript' })),
        };
        const recordingMicSession = {
            beginRecording: vi.fn(async () => {}),
            stopRecording: vi.fn(async () => 'file:///recording.wav'),
            teardown: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            ensureActive: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => deviceController as never,
                createRecordingMicSession: () => recordingMicSession as never,
                createSherpaSttController: () => sherpaController as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: ' session-1 ',
        });

        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(true);
        expect(deviceController.start).toHaveBeenCalledWith(
            expect.objectContaining({
                micSession: expect.objectContaining({
                    ensureActive: expect.any(Function),
                    setMuted: expect.any(Function),
                }),
                sink: expect.objectContaining({
                    onAudioStarted: expect.any(Function),
                    onPartial: expect.any(Function),
                    onFinal: expect.any(Function),
                    onEndpoint: expect.any(Function),
                    onError: expect.any(Function),
                }),
                signal: expect.any(Object),
            }),
        );

        await expect(owner.stopCapture({
            provider: 'device',
            sessionId: 'session-1',
        })).resolves.toEqual({
            continueHandsFree: true,
            provider: 'device',
            text: 'device transcript',
        });

        owner.clearHandsFree({ provider: 'device', sessionId: 'session-1' });
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(false);
    });

    it('uses an attempt-scoped settings snapshot for Dictation capture without changing the ambient owner', async () => {
        const ambientSettings = { voice: { assistantLanguage: 'en-US' } };
        const dictationSettings = { voice: { assistantLanguage: 'de-CH' } };
        const observedSettings: unknown[] = [];
        const deviceController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        };
        const liveMicSession = {
            teardown: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            ensureActive: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ambientSettings,
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: (deps) => {
                    deviceController.start.mockImplementation(async () => {
                        observedSettings.push(deps.getSettings());
                    });
                    return deviceController as never;
                },
                createLiveMicSession: () => liveMicSession as never,
            },
        );

        await owner.startCapture({
            handsFree: false,
            provider: 'device',
            sessionId: 'dictation-session',
            settings: dictationSettings,
        });
        expect(observedSettings).toEqual([dictationSettings]);

        await owner.stopCapture({ provider: 'device', sessionId: 'dictation-session' });
        await owner.startCapture({
            handsFree: false,
            provider: 'device',
            sessionId: 'local-session',
        });
        expect(observedSettings).toEqual([dictationSettings, ambientSettings]);
    });

    it('clears all runtime-owned hands-free sessions when stopping the capture owner', async () => {
        const deviceController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        };
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        };
        const recordingMicSession = {
            beginRecording: vi.fn(async () => {}),
            stopRecording: vi.fn(async () => 'file:///recording.wav'),
            teardown: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            ensureActive: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => deviceController as never,
                createRecordingMicSession: () => recordingMicSession as never,
                createSherpaSttController: () => sherpaController as never,
            },
        );

        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-1' });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', sessionId: 'session-2' });
        await owner.startCapture({ handsFree: false, provider: 'recorded_audio', sessionId: 'session-3' });

        await owner.stopSession();

        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(false);
        expect(owner.isHandsFreeCaptureSession({ provider: 'local_neural', sessionId: 'session-2' })).toBe(false);
        expect(recordingMicSession.teardown).toHaveBeenCalledTimes(1);
    });

    it('keeps endpoint signal gating and stopped-capture decisions in the runtime capture owner', async () => {
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: 'open the latest notes' })),
        };
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => sherpaController as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'local_neural',
            sessionId: ' session-1 ',
        });

        expect(sherpaController.start).toHaveBeenCalledWith(
            expect.objectContaining({
                micSession: expect.objectContaining({
                    ensureActive: expect.any(Function),
                    setMuted: expect.any(Function),
                }),
                sink: expect.objectContaining({
                    onError: expect.any(Function),
                }),
                signal: expect.any(Object),
            }),
        );

        expect('resolveEndpointSignalAction' in owner).toBe(true);
        expect('stopEndpointDrivenCapture' in owner).toBe(true);
        if (!('resolveEndpointSignalAction' in owner) || !('stopEndpointDrivenCapture' in owner)) {
            return;
        }

        expect(owner.resolveEndpointSignalAction({
            currentSessionId: 'session-1',
            currentStatus: 'recording',
            handsFreeEnabled: true,
            inFlight: false,
            provider: 'local_neural',
            signal: {
                detectedAt: 1_000,
                endpoint: { reason: 'acoustic_endpoint', confidence: null },
                sessionId: 'session-1',
                source: 'native_stream',
                transcript: 'open the latest notes',
            },
        })).toEqual({
            kind: 'stop_capture',
            provider: 'local_neural',
            sessionId: 'session-1',
        });

        await expect(owner.stopEndpointDrivenCapture({
            adaptiveConfig: { ignoredPhrases: ['yeah'] },
            provider: 'local_neural',
            sessionId: 'session-1',
        })).resolves.toEqual({
            kind: 'submit_turn',
            followUp: {
                kind: 'rearm_capture',
                provider: 'local_neural',
                sessionId: 'session-1',
            },
            transcript: 'open the latest notes',
        });
        expect(sherpaController.stop).toHaveBeenCalledWith();
    });

    it('projects daemon endpoint events once through the canonical hands-free stop decision', async () => {
        let captureOptions: DaemonSpeechPcmCaptureOptions | null = null;
        const sender = {
            start: vi.fn(async () => {}),
            pushChunk: vi.fn(async () => [
                {
                    type: 'partial' as const,
                    seq: 0,
                    text: 'open the latest notes',
                    isEndpoint: true,
                    confidence: null,
                },
                {
                    type: 'endpoint' as const,
                    seq: 0,
                    transcript: 'open the latest notes',
                    reason: 'vad' as const,
                },
            ]),
            finish: vi.fn(async () => ({
                ok: true as const,
                streamId: 'stream-1',
                generation: 1,
                ackSeq: 0,
                finalText: 'open the latest notes',
                language: 'en',
                modelPackId: 'stt-pack-1',
                events: [],
            })),
            cancel: vi.fn(async () => {}),
        };
        const capture = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            waitForDrain: vi.fn(async () => {}),
            isActive: vi.fn(() => true),
        };
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const onEndpointSignal = vi.fn();
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({
                    voice: {
                        providerId: 'local_conversation',
                        providers: {
                            local_conversation: {
                                schemaVersion: 1,
                                config: {
                                    stt: {
                                        provider: 'local_neural',
                                        localNeural: {
                                            assetId: 'stt-pack-1',
                                            execution: 'daemon',
                                            language: 'en',
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
                onEndpointSignal,
            },
            {
                createDaemonStreamingSttController: (controllerDeps) =>
                    createDaemonStreamingSttController({
                        ...controllerDeps,
                        createClient: () => ({
                            createStreamingSttSender: vi.fn(async () => sender),
                        }),
                        createPcmCapture: (options) => {
                            captureOptions = options;
                            return capture;
                        },
                    }),
                createLiveMicSession: () => liveMicSession,
            },
        );

        await owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'daemon',
            provider: 'local_neural',
            sessionId: ' control-session ',
        });
        await requireDaemonCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]));

        expect(onEndpointSignal).toHaveBeenCalledTimes(1);
        const endpointSignal = onEndpointSignal.mock.calls[0]?.[0] as TurnEndpointSignal;
        expect(endpointSignal).toEqual(expect.objectContaining({
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 'control-session',
            source: 'daemon_stream',
            transcript: 'open the latest notes',
        }));
        expect(owner.resolveEndpointSignalAction({
            currentSessionId: 'control-session',
            currentStatus: 'recording',
            handsFreeEnabled: true,
            inFlight: false,
            provider: 'local_neural',
            signal: endpointSignal,
        })).toEqual({
            kind: 'stop_capture',
            provider: 'local_neural',
            sessionId: 'control-session',
        });

        await owner.stopSession('control-session');
    });

    it('keeps manual barge-in decisions and endpoint-controller wiring in the runtime capture owner', async () => {
        const createDeviceSttController = vi.fn(() => ({
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        }));
        const createSherpaSttController = vi.fn(() => ({
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        }));

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController,
            },
        );

        expect(owner.resolveManualBargeInAction({
            bargeInEnabled: true,
            currentSessionId: 'session-1',
            currentStatus: 'speaking',
            handsFree: true,
            provider: 'device',
            requestedSessionId: 'session-1',
        })).toEqual({
            kind: 'interrupt_and_rearm',
            handsFree: true,
            provider: 'device',
            sessionId: 'session-1',
        });

        expect(createDeviceSttController).not.toHaveBeenCalled();
        expect(createSherpaSttController).not.toHaveBeenCalled();

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-1',
        });
        await owner.startCapture({
            handsFree: true,
            provider: 'local_neural',
            sessionId: 'session-1',
        });

        expect(createDeviceSttController).toHaveBeenCalledWith(expect.objectContaining({
            endpointController: expect.any(Object),
            onSpeechCandidateStart: expect.any(Function),
            onSpeechCandidateFalseAlarm: expect.any(Function),
            webVadController: expect.any(Object),
        }));
        expect(createSherpaSttController).toHaveBeenCalledWith(expect.objectContaining({
            endpointController: expect.any(Object),
        }));
    });

    it('keeps mute plumbing in the runtime capture owner and reapplies it when the same session rearms', async () => {
        const setMuted = vi.fn();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted,
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const deviceController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => deviceController as never,
                createLiveMicSession: () => liveMicSession as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-1',
        });
        await owner.setMuted({ muted: true, sessionId: 'session-1' });
        await owner.stopCapture({
            provider: 'device',
            sessionId: 'session-1',
        });
        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-1',
        });

        expect(deviceController.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ micSession: liveMicSession }));
        expect(deviceController.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ micSession: liveMicSession }));
        expect(setMuted).toHaveBeenCalledWith(true);
        expect(setMuted).toHaveBeenLastCalledWith(true);
    });

    it('surfaces live web mic failures through the runtime capture owner instead of leaving browser track loss local-only', async () => {
        const onCaptureError = vi.fn();
        let activeSttSignal: AbortSignal | null = null;
        let liveMicOptions: { onFailure?: (failure: { kind: 'mic_ended' | 'audio_context_suspended'; reason: string }) => void } | undefined;
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError,
            },
            {
                createDeviceSttController: () => ({
                    start: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                        activeSttSignal = signal;
                    }),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
                createLiveMicSession: ((options?: typeof liveMicOptions) => {
                    liveMicOptions = options;
                    return liveMicSession as never;
                }) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-web',
        });
        expect(requireObservedSttSignal(activeSttSignal).aborted).toBe(false);
        liveMicOptions?.onFailure?.({
            kind: 'mic_ended',
            reason: 'web_mic_track_ended',
        });

        expect(requireObservedSttSignal(activeSttSignal).aborted).toBe(true);
        await vi.waitFor(() => {
            expect(onCaptureError).toHaveBeenCalledTimes(1);
        });
        expect(onCaptureError).toHaveBeenCalledWith({
            controlSessionId: 'session-web',
            kind: 'mic_ended',
            reason: 'web_mic_track_ended',
        });
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-web' })).toBe(false);
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
    });

    it('ignores a stale live mic failure after the capture owner has restarted', async () => {
        const onCaptureError = vi.fn();
        const sttSignals: AbortSignal[] = [];
        const liveMicFailures: Array<(failure: {
            kind: 'mic_ended';
            reason: string;
        }) => void> = [];
        const liveMicSessions = Array.from({ length: 2 }, () => ({
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        }));
        let nextLiveMicSession = 0;

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError,
            },
            {
                createDeviceSttController: () => ({
                    start: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                        sttSignals.push(signal);
                    }),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
                createLiveMicSession: ((options?: {
                    onFailure?: (failure: { kind: 'mic_ended'; reason: string }) => void;
                }) => {
                    if (options?.onFailure) {
                        liveMicFailures.push(options.onFailure);
                    }
                    const session = liveMicSessions[nextLiveMicSession];
                    nextLiveMicSession += 1;
                    if (!session) {
                        throw new Error('unexpected_live_mic_session_creation');
                    }
                    return session as never;
                }) as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-web',
        });
        await owner.stopSession('session-web');
        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-web',
        });

        liveMicFailures[0]?.({
            kind: 'mic_ended',
            reason: 'stale_web_mic_track_ended',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(sttSignals).toHaveLength(2);
        expect(sttSignals[1]?.aborted).toBe(false);
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(liveMicSessions[1]?.teardown).not.toHaveBeenCalled();

        await owner.stopSession('session-web');
    });

    it.each(['live mic failure', 'STT failure'] as const)(
        'retains product admission until failed live mic teardown settles after %s, including concurrent stop',
        async (failureSource) => {
            let resolveTeardown!: () => void;
            const teardownSettled = new Promise<void>((resolve) => {
                resolveTeardown = resolve;
            });
            let activeSink: {
                onError: (failure: { kind: 'mic_ended'; reason: string }) => void;
            } | null = null;
            let liveMicOptions: {
                onFailure?: (failure: { kind: 'mic_ended'; reason: string }) => void;
            } | undefined;
            const liveMicSession = {
                ensureActive: vi.fn(async () => {}),
                setMuted: vi.fn(),
                isMuted: vi.fn(() => false),
                teardown: vi.fn(() => teardownSettled),
                getStream: vi.fn(() => null),
            };
            const admission = createVoiceCaptureAdmissionController();
            let captureOwner!: ReturnType<typeof createVoiceCaptureAdmissionBinding>;
            const rawCaptureOwner = createLocalVoiceCaptureOwner(
                {
                    getSettings: () => ({}),
                    onCaptureStarted: vi.fn(),
                    onCaptureError: (error) => {
                        captureOwner.releaseAdmission(error.controlSessionId);
                    },
                },
                {
                    createDeviceSttController: () => ({
                        start: vi.fn(async ({ sink }) => {
                            activeSink = sink;
                        }),
                        stop: vi.fn(async () => ({ finalText: '' })),
                    }) as never,
                    createLiveMicSession: ((options?: typeof liveMicOptions) => {
                        liveMicOptions = options;
                        return liveMicSession as never;
                    }) as never,
                },
            );
            captureOwner = createVoiceCaptureAdmissionBinding({
                admission,
                captureOwner: rawCaptureOwner,
                productOwner: 'dictation',
            });

            await captureOwner.startCapture({
                handsFree: true,
                provider: 'device',
                sessionId: 'dictation-session',
            });
            const failure = {
                kind: 'mic_ended' as const,
                reason: 'web_mic_track_ended',
            };
            if (failureSource === 'live mic failure') {
                liveMicOptions?.onFailure?.(failure);
            } else {
                requireObservedSttErrorSink(activeSink).onError(failure);
            }
            const stopPromise = captureOwner.stopSession('dictation-session');

            await vi.waitFor(() => {
                expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
            });
            expect(admission.acquire('conversation')).toEqual({
                status: 'busy',
                activeOwner: 'dictation',
            });

            resolveTeardown();
            await stopPromise;

            expect(admission.acquire('conversation').status).toBe('acquired');
        },
    );

    it('waits for provider cleanup and live mic teardown before publishing an STT runtime failure', async () => {
        const providerCleanup = createDeferred();
        const micCleanup = createDeferred();
        let activeSink: {
            onError: (failure: { kind: 'mic_ended'; reason: string }) => void;
        } | null = null;
        const controllerStop = vi.fn(() => providerCleanup.promise.then(() => ({ finalText: '' })));
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(() => micCleanup.promise),
            getStream: vi.fn(() => null),
        };
        const admission = createVoiceCaptureAdmissionController();
        const onCaptureError = vi.fn();
        let captureOwner!: ReturnType<typeof createVoiceCaptureAdmissionBinding>;
        const rawCaptureOwner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: (error) => {
                    onCaptureError(error);
                    captureOwner.releaseAdmission(error.controlSessionId);
                },
            },
            {
                createDeviceSttController: () => ({
                    start: vi.fn(async ({ sink }) => {
                        activeSink = sink;
                    }),
                    stop: controllerStop,
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
            },
        );
        captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
        await captureOwner.startCapture({
            handsFree: false,
            provider: 'device',
            sessionId: 'dictation-session',
        });

        requireObservedSttErrorSink(activeSink).onError({
            kind: 'mic_ended',
            reason: 'device_runtime_failed',
        });
        const stopping = captureOwner.stopSession('dictation-session');
        await Promise.resolve();

        expect(controllerStop).toHaveBeenCalledTimes(1);
        expect(liveMicSession.teardown).not.toHaveBeenCalled();
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        providerCleanup.resolve();
        await vi.waitFor(() => {
            expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
        });
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        micCleanup.resolve();
        await stopping;

        expect(onCaptureError).toHaveBeenCalledWith({
            controlSessionId: 'dictation-session',
            kind: 'mic_ended',
            reason: 'device_runtime_failed',
        });
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it.each([
        {
            label: 'recorded audio',
            provider: 'recorded_audio' as const,
            localNeuralExecution: undefined,
        },
        {
            label: 'device recognizer',
            provider: 'device' as const,
            localNeuralExecution: undefined,
        },
        {
            label: 'local neural device PCM',
            provider: 'local_neural' as const,
            localNeuralExecution: 'device' as const,
        },
        {
            label: 'local neural daemon stream',
            provider: 'local_neural' as const,
            localNeuralExecution: 'daemon' as const,
        },
    ])('retains admission until a late $label start settles and final teardown completes', async ({
        provider,
        localNeuralExecution,
    }) => {
        const startSettled = createDeferred();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const recordingMicSession = {
            ...liveMicSession,
            beginRecording: vi.fn(() => startSettled.promise),
            stopRecording: vi.fn(async () => 'file:///recording.wav'),
        };
        const controllerStart = vi.fn(() => startSettled.promise);
        const controllerStop = vi.fn(async () => ({ finalText: '' }));
        const admission = createVoiceCaptureAdmissionController();
        const rawCaptureOwner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDaemonStreamingSttController: () => ({
                    start: controllerStart,
                    stop: controllerStop,
                }) as never,
                createDeviceSttController: () => ({
                    start: controllerStart,
                    stop: controllerStop,
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
                createRecordingMicSession: (() => recordingMicSession) as never,
                createSherpaSttController: () => ({
                    start: controllerStart,
                    stop: controllerStop,
                }) as never,
            },
        );
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });

        const startPromise = captureOwner.startCapture({
            handsFree: false,
            provider,
            sessionId: 'dictation-session',
            ...(localNeuralExecution ? { localNeuralExecution } : {}),
        });
        await Promise.resolve();
        const stopPromise = captureOwner.stopSession('dictation-session');
        let stopFinished = false;
        void stopPromise.then(() => {
            stopFinished = true;
        });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(stopFinished).toBe(false);
        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        startSettled.resolve();
        await Promise.all([startPromise, stopPromise]);

        expect(provider === 'recorded_audio'
            ? recordingMicSession.teardown
            : liveMicSession.teardown).toHaveBeenCalledTimes(1);
        expect(controllerStop).toHaveBeenCalledTimes(provider === 'recorded_audio' ? 0 : 1);
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('starts the silent-mic watchdog only after daemon STT startup settles', async () => {
        vi.useFakeTimers();
        try {
            const onCaptureStarted = vi.fn();
            const listeningAttempt = new AbortController();
            const onCaptureError = vi.fn(() => listeningAttempt.abort());
            let resolveDaemonStart!: () => void;
            const daemonStart = new Promise<void>((resolve) => {
                resolveDaemonStart = resolve;
            });
            let observedDaemonSignal: AbortSignal | null = null;
            const startDaemonStt = vi.fn((params: { signal: AbortSignal }) => {
                observedDaemonSignal = params.signal;
                return daemonStart;
            });
            const liveMicSession = {
                ensureActive: vi.fn(async () => {}),
                setMuted: vi.fn(),
                isMuted: vi.fn(() => false),
                teardown: vi.fn(async () => {}),
                getStream: vi.fn(() => null),
            };

            const owner = createLocalVoiceCaptureOwner(
                {
                    getSettings: () => ({}),
                    onCaptureStarted,
                    onCaptureError,
                },
                {
                    createDaemonStreamingSttController: () => ({
                        start: startDaemonStt,
                        stop: vi.fn(async () => ({ finalText: '' })),
                    }) as never,
                    createLiveMicSession: (() => liveMicSession) as never,
                    micPlateauTimeoutMs: 25,
                },
            );

            const startPromise = owner.startCapture({
                handsFree: false,
                localNeuralExecution: 'daemon',
                provider: 'local_neural',
                sessionId: 'session-daemon-start',
                signal: listeningAttempt.signal,
            });

            await vi.advanceTimersByTimeAsync(25);

            expect(startDaemonStt).toHaveBeenCalledTimes(1);
            expect(requireObservedSttSignal(observedDaemonSignal).aborted).toBe(false);
            expect(onCaptureError).not.toHaveBeenCalled();
            expect(liveMicSession.teardown).not.toHaveBeenCalled();

            resolveDaemonStart();
            await startPromise;
            expect(onCaptureStarted).toHaveBeenCalledWith('session-daemon-start');

            await vi.advanceTimersByTimeAsync(25);
            expect(onCaptureError).toHaveBeenCalledWith({
                controlSessionId: 'session-daemon-start',
                kind: 'mic_plateau',
                reason: 'mic_audio_plateau',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('tracks the latest STT partial for VAD endpoint signals even when no UI partial callback is mounted', async () => {
        (globalThis as { window?: object }).window = {};
        (globalThis as { document?: object }).document = {};

        const onEndpointSignal = vi.fn();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const deviceStop = vi.fn(async () => ({ finalText: '' }));

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
                onEndpointSignal,
            },
            {
                createDeviceSttController: (controllerDeps) => ({
                    start: vi.fn(async ({ micSession, sink }) => {
                        if (!controllerDeps.webVadController) {
                            throw new Error('web_vad_controller_missing');
                        }
                        sink.onPartial('  interrupt that  ');
                        await controllerDeps.webVadController.startSession({
                            minSpeechMs: 0,
                            redemptionMs: 0,
                            sessionId: 'session-vad',
                            micSession,
                        });
                        activeOnSpeechEnd?.();
                    }),
                    stop: deviceStop,
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-vad',
        });

        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-vad',
            source: 'web_vad',
            transcript: 'interrupt that',
        }));
    });

    it('maps VAD candidate edges onto the active control-session owner', async () => {
        (globalThis as { window?: object }).window = {};
        (globalThis as { document?: object }).document = {};
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}), setMuted: vi.fn(), isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}), getStream: vi.fn(() => null),
        };
        const owner = createLocalVoiceCaptureOwner({
            getSettings: () => ({}),
            onCaptureStarted: vi.fn(),
            onCaptureError: vi.fn(),
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
        }, {
            createDeviceSttController: (controllerDeps) => ({
                start: vi.fn(async ({ micSession }) => {
                    await controllerDeps.webVadController?.startSession({
                        minSpeechMs: 0,
                        redemptionMs: 0,
                        sessionId: 'internal-vad-session',
                        micSession,
                    });
                    activeOnSpeechStart?.();
                    activeOnSpeechEnd?.();
                }),
                stop: vi.fn(async () => ({ finalText: '' })),
            }) as never,
            createLiveMicSession: (() => liveMicSession) as never,
            createRecordingMicSession: (() => liveMicSession) as never,
            createSherpaSttController: () => ({
                start: vi.fn(async () => {}), stop: vi.fn(async () => ({ finalText: '' })),
            }) as never,
        });

        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'control-session' });
        expect(onSpeechCandidateStart).toHaveBeenCalledWith({
            controlSessionId: 'control-session', source: 'web_vad',
        });

        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({
            controlSessionId: 'control-session', source: 'web_vad',
        });

        await owner.stopCapture({ provider: 'device', sessionId: 'control-session' });
    });

    it('forwards finalized device-STT endpoint signals with the active control session id', async () => {
        const onEndpointSignal = vi.fn();
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
                onEndpointSignal,
            },
            {
                createDeviceSttController: (controllerDeps) => ({
                    start: vi.fn(async ({ sink }) => {
                        const endpointController = controllerDeps.endpointController;
                        if (!endpointController) {
                            throw new Error('endpoint_controller_missing');
                        }
                        endpointController.startSession('device-controller-session');
                        sink.onFinal('  finalized command  ');
                        endpointController.signalHeuristicTranscriptFinalized({
                            sessionId: 'device-controller-session',
                            transcript: 'finalized command',
                            policy: { silenceMs: 0, minSpeechMs: 0 },
                        });
                    }),
                    stop: vi.fn(async () => ({ finalText: 'finalized command' })),
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        await owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'control-session',
        });
        await Promise.resolve();

        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'control-session',
            source: 'heuristic',
            transcript: 'finalized command',
        }));
    });

    it('releases the live mic when an STT start throws so a failed startup never leaks capture', async () => {
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => ({
                    // Startup failure (e.g. recognizer init / native error).
                    start: vi.fn(async () => {
                        throw new Error('device_stt_start_failed');
                    }),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        await expect(owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-fail',
        })).rejects.toThrow('device_stt_start_failed');

        // The mic was activated before the recognizer threw; it must be released.
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
        // And hands-free ownership must not survive a failed startup.
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-fail' })).toBe(false);
    });

    it('treats an external startup abort as cancelled capture instead of confirming a late mic start', async () => {
        const onCaptureStarted = vi.fn();
        const externalAbort = new AbortController();
        let observedSttSignal: AbortSignal | null = null;
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted,
                onCaptureError: vi.fn(),
            },
            {
                createDeviceSttController: () => ({
                    start: vi.fn(({ signal }) => new Promise<void>((resolve) => {
                        observedSttSignal = signal;
                        signal.addEventListener('abort', () => resolve(), { once: true });
                    })),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
                createLiveMicSession: (() => liveMicSession) as never,
                createRecordingMicSession: () => ({
                    beginRecording: vi.fn(async () => {}),
                    stopRecording: vi.fn(async () => 'file:///recording.wav'),
                    teardown: vi.fn(async () => {}),
                    setMuted: vi.fn(),
                    isMuted: vi.fn(() => false),
                    ensureActive: vi.fn(async () => {}),
                    getStream: vi.fn(() => null),
                }) as never,
                createSherpaSttController: () => ({
                    start: vi.fn(async () => {}),
                    stop: vi.fn(async () => ({ finalText: '' })),
                }) as never,
            },
        );

        const startPromise = owner.startCapture({
            handsFree: true,
            provider: 'device',
            sessionId: 'session-abort',
            signal: externalAbort.signal,
        });
        await vi.waitFor(() => {
            expect(observedSttSignal).not.toBeNull();
        });
        const sttSignal = requireObservedSttSignal(observedSttSignal);

        externalAbort.abort();
        await expect(Promise.race([
            startPromise.then(() => 'resolved' as const),
            new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
        ])).resolves.toBe('resolved');

        expect(sttSignal.aborted).toBe(true);
        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-abort' })).toBe(false);
    });

    it('composes native Silero over the shared local-neural PCM capture for candidate, false-alarm, and one confirmed endpoint', async () => {
        const pcm = createSharedNativePcmHarness();
        const sherpaController = createSharedPcmSherpaController(pcm.capture);
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const pushVadAudioFrame = vi
            .fn()
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true })
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true })
            // A repeated end edge cannot admit the already-confirmed candidate again.
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true });
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector,
            pushVadAudioFrame,
            cancelVadDetector,
        }, {
            frameSource: pcm.capture,
        });
        expect(bridge).not.toBeNull();

        let clock = 0;
        const duckPlayback = vi.fn();
        const restorePlayback = vi.fn();
        const admittedEndpoints: unknown[] = [];
        let latestPartial = '';
        let owner!: ReturnType<typeof createLocalVoiceCaptureOwner>;
        const onSpeechCandidateStart = vi.fn((input: Readonly<{
            controlSessionId: string;
            source: 'native_vad' | 'web_vad' | 'device_recognizer';
        }>) => {
            duckPlayback();
            expect(input).toEqual({
                controlSessionId: 'local-neural-session',
                source: 'native_vad',
            });
        });
        const onSpeechCandidateFalseAlarm = vi.fn((input: Readonly<{
            controlSessionId: string;
            source: 'native_vad' | 'web_vad' | 'device_recognizer';
        }>) => {
            restorePlayback();
            expect(input).toEqual({
                controlSessionId: 'local-neural-session',
                source: 'native_vad',
            });
        });
        const onEndpointSignal = vi.fn((signal: TurnEndpointSignal) => {
            const action = owner.resolveEndpointSignalAction({
                currentSessionId: 'local-neural-session',
                currentStatus: 'recording',
                handsFreeEnabled: true,
                inFlight: admittedEndpoints.length > 0,
                provider: 'local_neural',
                signal,
            });
            if (action.kind === 'stop_capture') {
                admittedEndpoints.push(action);
            }
        });
        const nativeVadController = createNativeVadController({
            bridge,
            now: () => clock,
            onEndpointSignal: (signal) => onEndpointSignal(signal),
            onSpeechCandidateStart: ({ sessionId, source }) => onSpeechCandidateStart({
                controlSessionId: sessionId,
                source,
            }),
            onSpeechCandidateFalseAlarm: ({ sessionId, source }) => onSpeechCandidateFalseAlarm({
                controlSessionId: sessionId,
                source,
            }),
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
            getLatestPartialTranscript: () => latestPartial,
        });
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };

        owner = createLocalVoiceCaptureOwner({
            getSettings: () => ({}),
            onCaptureStarted: vi.fn(),
            onCaptureError: vi.fn(),
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
            onPartialTranscript: ({ transcript }) => {
                latestPartial = transcript;
            },
        }, {
            createLiveMicSession: () => liveMicSession,
            createSherpaSttController: () => sherpaController as never,
            nativeVadController,
        });

        await owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'device',
            provider: 'local_neural',
            sessionId: 'local-neural-session',
        });

        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: 'shared-native-stream',
            subscriberCount: 2,
        });
        expect(pcm.nativeStart).toHaveBeenCalledTimes(1);
        expect(pcm.platformApply).toHaveBeenCalledTimes(1);

        clock = 0;
        pcm.emitFrame('candidate-start');
        await vi.waitFor(() => expect(duckPlayback).toHaveBeenCalledTimes(1));
        clock = 300;
        pcm.emitFrame('candidate-false-alarm');
        await vi.waitFor(() => expect(restorePlayback).toHaveBeenCalledTimes(1));
        expect(admittedEndpoints).toHaveLength(0);

        clock = 1_000;
        pcm.emitFrame('confirmed-start');
        await vi.waitFor(() => expect(duckPlayback).toHaveBeenCalledTimes(2));
        clock = 2_000;
        pcm.emitFrame('confirmed-end');
        await vi.waitFor(() => expect(admittedEndpoints).toHaveLength(1));
        expect(onEndpointSignal).toHaveBeenLastCalledWith(expect.objectContaining({
            durationMs: 1_000,
            sessionId: 'local-neural-session',
            source: 'native_vad',
            transcript: 'interrupt that',
        }));

        pcm.emitFrame('duplicate-end');
        await vi.waitFor(() => expect(pushVadAudioFrame).toHaveBeenCalledTimes(5));
        expect(admittedEndpoints).toHaveLength(1);

        await owner.stopCapture({
            provider: 'local_neural',
            sessionId: 'local-neural-session',
        });
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: null,
            subscriberCount: 0,
        });
        expect(pcm.nativeStop).toHaveBeenCalledTimes(1);
        expect(pcm.platformRestore).toHaveBeenCalledTimes(1);
    });

    it('releases the native VAD subscriber when local-neural startup is aborted', async () => {
        const pcm = createSharedNativePcmHarness();
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector,
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector,
        }, {
            frameSource: pcm.capture,
        });
        expect(bridge).not.toBeNull();
        const nativeVadController = createNativeVadController({
            bridge,
            onEndpointSignal: vi.fn(),
        });
        let sherpaLease: VoicePcmCaptureLease | null = null;
        const sherpaStartEntered = createDeferred();
        const sherpaController = {
            start: vi.fn(async ({ sessionId, signal }: Readonly<{
                sessionId: string;
                signal: AbortSignal;
            }>) => {
                sherpaLease = await pcm.capture.acquire({
                    ownerId: `sherpa-owner-test:${sessionId}`,
                    format: { sampleRate: 16_000, channels: 1, frameMs: 20 },
                    audioSession: {
                        mode: 'conversation',
                        input: true,
                        output: true,
                        aec: 'preferred',
                    },
                    onFrame: () => {},
                });
                sherpaStartEntered.resolve();
                await new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
            }),
            stop: vi.fn(async () => {
                const lease = sherpaLease;
                sherpaLease = null;
                await lease?.release();
                await lease?.waitForDrain();
                return { finalText: '' };
            }),
        };
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const owner = createLocalVoiceCaptureOwner({
            getSettings: () => ({}),
            onCaptureStarted: vi.fn(),
            onCaptureError: vi.fn(),
        }, {
            createLiveMicSession: () => liveMicSession,
            createSherpaSttController: () => sherpaController as never,
            nativeVadController,
        });
        const abortController = new AbortController();

        const startPromise = owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'device',
            provider: 'local_neural',
            sessionId: 'local-neural-abort',
            signal: abortController.signal,
        });
        await sherpaStartEntered.promise;
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(2);

        abortController.abort();
        await startPromise;

        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: 'shared-native-stream',
            // The abort removed the VAD subscriber immediately; the independent
            // Sherpa subscriber remains until the owner finishes session cleanup.
            subscriberCount: 1,
        });
        expect(pcm.nativeStop).not.toHaveBeenCalled();

        await owner.stopSession('local-neural-abort');
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: null,
            subscriberCount: 0,
        });
        expect(pcm.nativeStop).toHaveBeenCalledTimes(1);
        expect(pcm.platformRestore).toHaveBeenCalledTimes(1);
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
    });

    it('settles End while native VAD startup is pending and disposes the late detector and PCM lease', async () => {
        const nativeStartEntered = createDeferred();
        const releaseNativeStart = createDeferred();
        const pcm = createSharedNativePcmHarness({
            nativeStart: async () => {
                nativeStartEntered.resolve();
                await releaseNativeStart.promise;
                return { streamId: 'shared-native-stream' };
            },
        });
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector,
            pushVadAudioFrame: vi.fn(async () => ({
                speechStarted: true,
                speechEnded: true,
            })),
            cancelVadDetector,
        }, {
            frameSource: pcm.capture,
        });
        expect(bridge).not.toBeNull();

        const onCaptureStarted = vi.fn();
        const onEndpointSignal = vi.fn();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        const nativeVadController = createNativeVadController({
            bridge,
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
        });
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ({ finalText: '' })),
        };
        const liveMicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => null),
        };
        const owner = createLocalVoiceCaptureOwner({
            getSettings: () => ({}),
            onCaptureStarted,
            onCaptureError: vi.fn(),
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
        }, {
            createLiveMicSession: () => liveMicSession,
            createSherpaSttController: () => sherpaController as never,
            nativeVadController,
        });

        const startPromise = owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'device',
            provider: 'local_neural',
            sessionId: 'local-neural-pending-vad',
        });
        await nativeStartEntered.promise;
        expect(createVadDetector).toHaveBeenCalledTimes(1);
        expect(pcm.platformApply).toHaveBeenCalledTimes(1);

        const stopPromise = owner.stopSession('local-neural-pending-vad');
        const stopOutcome = await Promise.race([
            stopPromise.then(() => 'settled' as const),
            new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
        ]);

        // Let the uncancellable native start finish after End. Its late session
        // must be recognized as stale and immediately release both resources.
        releaseNativeStart.resolve();
        await Promise.all([startPromise, stopPromise]);
        await vi.waitFor(() => expect(cancelVadDetector).toHaveBeenCalledTimes(1));

        expect(stopOutcome).toBe('settled');
        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(sherpaController.start).not.toHaveBeenCalled();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(onSpeechCandidateStart).not.toHaveBeenCalled();
        expect(onSpeechCandidateFalseAlarm).not.toHaveBeenCalled();
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: null,
            subscriberCount: 0,
        });
        expect(pcm.nativeStop).toHaveBeenCalledTimes(1);
        expect(pcm.platformRestore).toHaveBeenCalledTimes(1);
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
    });
});

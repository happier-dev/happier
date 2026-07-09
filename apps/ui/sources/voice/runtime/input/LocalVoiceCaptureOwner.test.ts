import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalVoiceCaptureOwner } from './LocalVoiceCaptureOwner';

const micVadNew = vi.fn();
const micVadStart = vi.fn();
const micVadPause = vi.fn();
let activeOnSpeechEnd: (() => void) | null = null;

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

describe('createLocalVoiceCaptureOwner', () => {
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

    beforeEach(() => {
        micVadNew.mockReset();
        micVadStart.mockReset();
        micVadPause.mockReset();
        activeOnSpeechEnd = null;
        micVadNew.mockImplementation(async (options: { onSpeechEnd?: () => void }) => {
            activeOnSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
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
            nativeVadController: expect.any(Object),
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
                    start: vi.fn(async () => {}),
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
        liveMicOptions?.onFailure?.({
            kind: 'mic_ended',
            reason: 'web_mic_track_ended',
        });

        expect(onCaptureError).toHaveBeenCalledWith({
            controlSessionId: 'session-web',
            kind: 'mic_ended',
            reason: 'web_mic_track_ended',
        });
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-web' })).toBe(false);
        expect(liveMicSession.teardown).toHaveBeenCalledTimes(1);
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
});

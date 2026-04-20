import { describe, expect, it, vi } from 'vitest';

import { createLocalVoiceCaptureOwner } from './LocalVoiceCaptureOwner';

describe('createLocalVoiceCaptureOwner', () => {
    it('keeps hands-free session ownership in the runtime capture owner instead of the provider controllers', async () => {
        const deviceController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => 'device transcript'),
        };
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => 'local neural transcript'),
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
            ' session-1 ',
            expect.objectContaining({
                ensureActive: expect.any(Function),
                setMuted: expect.any(Function),
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
            stop: vi.fn(async () => ''),
        };
        const sherpaController = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ''),
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
            stop: vi.fn(async () => 'open the latest notes'),
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
                    stop: vi.fn(async () => ''),
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
            ' session-1 ',
            expect.objectContaining({
                ensureActive: expect.any(Function),
                setMuted: expect.any(Function),
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
        expect(sherpaController.stop).toHaveBeenCalledWith('session-1');
    });

    it('keeps manual barge-in decisions and endpoint-controller wiring in the runtime capture owner', async () => {
        const createDeviceSttController = vi.fn(() => ({
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ''),
        }));
        const createSherpaSttController = vi.fn(() => ({
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => ''),
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
            stop: vi.fn(async () => ''),
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
                    stop: vi.fn(async () => ''),
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

        expect(deviceController.start).toHaveBeenNthCalledWith(1, 'session-1', liveMicSession);
        expect(deviceController.start).toHaveBeenNthCalledWith(2, 'session-1', liveMicSession);
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
                    stop: vi.fn(async () => ''),
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
                    stop: vi.fn(async () => ''),
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
});

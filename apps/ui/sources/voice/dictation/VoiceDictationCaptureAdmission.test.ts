import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceDictationController } from './VoiceDictationController';
import { createLocalVoiceCaptureOwner } from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createNativeMicSession, createExpoAudioRecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { createVoiceFileRecording } from '@happier-dev/audio-stream-native';
import { recordedAudioTranscriptionController } from '@/voice/runtime/input/recordedAudioTranscriptionController';

const recognition = vi.hoisted(() => ({ listeners: new Map<string, (event: unknown) => void>() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-audio', () => ({ AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }) } }));
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    addListener: (name: string, listener: (event: unknown) => void) => {
        recognition.listeners.set(name, listener);
        return { remove: () => { recognition.listeners.delete(name); } };
    },
    start: () => { recognition.listeners.get('audiostart')?.({}); },
    stop: () => {
        recognition.listeners.get('result')?.({ isFinal: true, results: [{ transcript: 'dictated transcript' }] });
        recognition.listeners.get('end')?.({});
    },
} }));

function createCaptureBoundary(stopRecording: () => Promise<string | null> = async () => 'file:///dictation.m4a') {
    const native = createNativeVoicePcmCaptureHarness();
    const sdk = { ...native.nativeModule,
        startFileRecording: vi.fn(async () => ({ recordingId: 'dictation-recording' })),
        setFileRecordingMuted: vi.fn(async () => {}),
        stopFileRecording: vi.fn(async () => ({ uri: await stopRecording() ?? '' })),
    };
    const real = createLocalVoiceCaptureOwner({ getSettings: () => DEVICE_STT_SETTINGS,
        onCaptureStarted: () => {}, onCaptureError: () => {} }, {
        createDeviceSttController: deps => createDeviceSttController({ ...deps, getAudioSessionCoordinator: () => native.coordinator }),
        createLiveMicSession: () => createNativeMicSession(),
        createRecordingMicSession: () => createExpoAudioRecordingMicSession({
            requestPermission: async () => ({ granted: true, canAskAgain: true }),
            acquireAudioMode: () => native.coordinator.acquire({ ownerId: 'dictation-test', mode: 'dictation',
                input: true, output: false, aec: 'off', capture: 'provider_managed_exclusive' }),
            createNativeFileRecording: () => createVoiceFileRecording(sdk),
        }),
    });
    // Observe the actual owner; none of these spies substitutes its decisions.
    return { startCapture: vi.fn(real.startCapture), stopCapture: vi.fn(real.stopCapture), stopSession: vi.fn(real.stopSession) };
}

const DEVICE_STT_SETTINGS = {
    voice: {
        providerId: 'local_conversation',
        providers: {
            local_conversation: {
                schemaVersion: 1,
                config: { stt: { provider: 'device' } },
            },
        },
    },
} as const;

function createHarness() {
    const admission = createVoiceCaptureAdmissionController();
    const rawCaptureOwner = createCaptureBoundary();
    const captureOwner = createVoiceCaptureAdmissionBinding({
        admission,
        captureOwner: rawCaptureOwner,
        productOwner: 'dictation',
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => DEVICE_STT_SETTINGS,
        transcribeRecordedAudio: recordedAudioTranscriptionController.transcribe,
        measureRecordedAudioBytes: vi.fn(async () => 0),
        deleteRecordedAudio: vi.fn(async () => {}),
    });
    return {
        admission,
        controller,
        rawCaptureOwner,
    };
}

describe('Dictation capture admission integration', () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it('rejects Dictation at its public controller before mic acquisition when Voice started first', async () => {
        const { admission, controller, rawCaptureOwner } = createHarness();
        const conversation = admission.acquire('conversation');
        if (conversation.status !== 'acquired') throw new Error('expected conversation admission');

        await expect(controller.toggle('session-1')).rejects.toMatchObject({
            name: 'VoiceCaptureBusyError',
            code: 'voice_capture_busy_conversation',
            activeOwner: 'conversation',
        });
        expect(rawCaptureOwner.startCapture).not.toHaveBeenCalled();
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it('blocks Voice while Dictation owns the utterance and releases after completion', async () => {
        const { admission, controller, rawCaptureOwner } = createHarness();

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'dictated transcript',
        });
        expect(rawCaptureOwner.startCapture).toHaveBeenCalledOnce();
        expect(rawCaptureOwner.stopCapture).toHaveBeenCalledOnce();
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('releases admission when navigation cancels Dictation', async () => {
        const { admission, controller, rawCaptureOwner } = createHarness();
        await controller.toggle('session-1');

        await controller.cancel('session-1');

        expect(rawCaptureOwner.stopSession).toHaveBeenCalledOnce();
        await rawCaptureOwner.stopSession.mock.results[0]?.value;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('abandons a never-settling stop, permits Conversation Voice immediately, and cleans one late artifact once', async () => {
        let resolveStop!: (uri: string) => void;
        const stopEntered = createDeferred<void>();
        const rawCaptureOwner = createCaptureBoundary(() => {
            stopEntered.resolve();
            return new Promise<string>(resolve => { resolveStop = resolve; });
        });
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
        const deleted = createDeferred<void>();
        const deleteRecordedAudio = vi.fn(async () => { deleted.resolve(); });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'explicit', stt: { provider: 'happier.voice.openai-compat/stt' } },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: recordedAudioTranscriptionController.transcribe,
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
        });

        await controller.toggle('dictation-session');
        const completion = controller.toggle('dictation-session');
        await stopEntered.promise;
        await controller.cancel('dictation-session');
        await expect(completion).resolves.toEqual({ kind: 'cancelled' });

        expect(rawCaptureOwner.stopSession).toHaveBeenCalledWith('dictation-session');
        const conversation = admission.acquire('conversation');
        expect(conversation.status).toBe('acquired');
        if (conversation.status === 'acquired') conversation.lease.release();

        await expect(controller.toggle('dictation-session-2')).resolves.toEqual({ kind: 'started' });
        resolveStop('file:///late-dictation.m4a');
        await deleted.promise;
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///late-dictation.m4a');
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: 'dictation-session-2',
            status: 'listening',
        });
        await controller.cancel('dictation-session-2');
    });
});

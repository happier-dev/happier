import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceDictationController, VOICE_DICTATION_LIMITS } from './VoiceDictationController';

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
    const rawCaptureOwner = {
        startCapture: vi.fn(async () => {}),
        stopCapture: vi.fn(async () => ({
            provider: 'device' as const,
            text: 'dictated transcript',
            continueHandsFree: false,
        })),
        stopSession: vi.fn(async () => {}),
    };
    const captureOwner = createVoiceCaptureAdmissionBinding({
        admission,
        captureOwner: rawCaptureOwner,
        productOwner: 'dictation',
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => DEVICE_STT_SETTINGS,
        transcribeRecordedAudio: vi.fn(),
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

        await vi.waitFor(() => {
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledOnce();
            expect(admission.acquire('conversation').status).toBe('acquired');
        });
    });

    it('abandons a never-settling stop, permits Conversation Voice immediately, and cleans one late artifact once', async () => {
        vi.useFakeTimers();
        let resolveStop!: (result: Readonly<{
            provider: 'recorded_audio';
            uri: string;
        }>) => void;
        const rawCaptureOwner = {
            startCapture: vi.fn(async () => {}),
            stopCapture: vi.fn(() => new Promise<Readonly<{
                provider: 'recorded_audio';
                uri: string;
            }>>((resolve) => {
                resolveStop = resolve;
            })),
            stopSession: vi.fn(async () => {}),
        };
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
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
            transcribeRecordedAudio: vi.fn(async () => 'stale transcript'),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
        });

        await controller.toggle('dictation-session');
        const completion = controller.toggle('dictation-session');
        await vi.advanceTimersByTimeAsync(VOICE_DICTATION_LIMITS.transcriptionDeadlineMs + 1);
        await expect(completion).resolves.toEqual({ kind: 'cancelled' });

        expect(rawCaptureOwner.stopSession).toHaveBeenCalledWith('dictation-session');
        const conversation = admission.acquire('conversation');
        expect(conversation.status).toBe('acquired');
        if (conversation.status === 'acquired') conversation.lease.release();

        await expect(controller.toggle('dictation-session-2')).resolves.toEqual({ kind: 'started' });
        resolveStop({
            provider: 'recorded_audio',
            uri: 'file:///late-dictation.m4a',
        });
        await vi.waitFor(() => {
            expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        });
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///late-dictation.m4a');
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: 'dictation-session-2',
            status: 'listening',
        });
        await controller.cancel('dictation-session-2');
    });
});

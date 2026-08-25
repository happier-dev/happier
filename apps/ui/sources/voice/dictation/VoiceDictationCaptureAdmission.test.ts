import { describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceDictationController } from './VoiceDictationController';

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
});

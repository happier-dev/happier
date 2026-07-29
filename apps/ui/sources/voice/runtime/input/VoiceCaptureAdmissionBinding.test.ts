import { describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from './VoiceCaptureAdmissionController';
import {
    createVoiceCaptureAdmissionBinding,
    VoiceCaptureBusyError,
} from './VoiceCaptureAdmissionBinding';

function createCaptureOwner() {
    return {
        startCapture: vi.fn(async () => {}),
        stopCapture: vi.fn(async () => ({
            provider: 'recorded_audio' as const,
            uri: 'file:///dictation.m4a',
        })),
        stopSession: vi.fn(async () => {}),
    };
}

describe('createVoiceCaptureAdmissionBinding', () => {
    it('rejects Dictation before capture when conversational Voice owns admission', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const conversation = admission.acquire('conversation');
        if (conversation.status !== 'acquired') throw new Error('expected conversation admission');
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await expect(binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        })).rejects.toEqual(expect.objectContaining({
            name: 'VoiceCaptureBusyError',
            code: 'voice_capture_busy_conversation',
            activeOwner: 'conversation',
        }));
        expect(captureOwner.startCapture).not.toHaveBeenCalled();
    });

    it('retains admission through transcription and releases it on cleanup', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        });
        await binding.stopCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
        });

        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        await binding.stopSession('session-1');
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it.each([
        ['navigation cancellation', 'stop_session'],
        ['capture error callback', 'release_admission'],
    ] as const)('releases after %s', async (_label, terminal) => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });
        await binding.startCapture({
            sessionId: 'session-1',
            provider: 'device',
            handsFree: false,
        });

        if (terminal === 'stop_session') {
            await binding.stopSession('session-1');
        } else {
            binding.releaseAdmission('session-1');
        }

        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('releases after permission or acquisition failure and preserves the typed cause', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        captureOwner.startCapture.mockRejectedValueOnce(new Error('mic_permission_denied'));
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await expect(binding.startCapture({
            sessionId: 'session-1',
            provider: 'device',
            handsFree: false,
        })).rejects.toThrow('mic_permission_denied');
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('exports a distinguishable busy error for controller remediation', () => {
        const error = new VoiceCaptureBusyError('conversation');
        expect(error).toMatchObject({
            name: 'VoiceCaptureBusyError',
            code: 'voice_capture_busy_conversation',
            activeOwner: 'conversation',
        });
    });
});

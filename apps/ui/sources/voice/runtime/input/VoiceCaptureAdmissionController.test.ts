import { describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from './VoiceCaptureAdmissionController';

const CAPTURE_PATHS = [
    'recorded_audio',
    'device_recognizer',
    'local_neural_device_pcm',
    'local_neural_daemon_stream',
    'web_capture',
] as const;

describe('createVoiceCaptureAdmissionController', () => {
    it.each(CAPTURE_PATHS)(
        'keeps one utterance owner when conversation starts before Dictation (%s)',
        () => {
            const controller = createVoiceCaptureAdmissionController();
            const acquireMic = vi.fn();
            const insertComposerText = vi.fn();
            const sendAgentTurn = vi.fn();

            const conversation = controller.acquire('conversation');
            expect(conversation).toMatchObject({ status: 'acquired' });
            if (conversation.status !== 'acquired') throw new Error('expected conversation admission');
            acquireMic();

            const dictation = controller.acquire('dictation');
            expect(dictation).toEqual({
                status: 'busy',
                activeOwner: 'conversation',
            });

            sendAgentTurn('conversation transcript');
            expect(acquireMic).toHaveBeenCalledOnce();
            expect(sendAgentTurn).toHaveBeenCalledOnce();
            expect(insertComposerText).not.toHaveBeenCalled();

            conversation.lease.release();
            expect(controller.acquire('dictation').status).toBe('acquired');
        },
    );

    it.each(CAPTURE_PATHS)(
        'keeps one utterance owner when Dictation starts before conversation (%s)',
        () => {
            const controller = createVoiceCaptureAdmissionController();
            const acquireMic = vi.fn();
            const insertComposerText = vi.fn();
            const sendAgentTurn = vi.fn();

            const dictation = controller.acquire('dictation');
            expect(dictation).toMatchObject({ status: 'acquired' });
            if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');
            acquireMic();

            const conversation = controller.acquire('conversation');
            expect(conversation).toEqual({
                status: 'busy',
                activeOwner: 'dictation',
            });

            insertComposerText('dictated transcript');
            expect(acquireMic).toHaveBeenCalledOnce();
            expect(insertComposerText).toHaveBeenCalledOnce();
            expect(sendAgentTurn).not.toHaveBeenCalled();

            dictation.lease.release();
            expect(controller.acquire('conversation').status).toBe('acquired');
        },
    );

    it('releases only the active lease and makes repeated release inert', () => {
        const controller = createVoiceCaptureAdmissionController();
        const acquired = controller.acquire('dictation');
        if (acquired.status !== 'acquired') throw new Error('expected Dictation admission');

        acquired.lease.release();
        acquired.lease.release();

        const next = controller.acquire('conversation');
        expect(next).toMatchObject({ status: 'acquired' });
        if (next.status !== 'acquired') throw new Error('expected conversation admission');

        acquired.lease.release();
        expect(controller.acquire('dictation')).toEqual({
            status: 'busy',
            activeOwner: 'conversation',
        });
    });
});

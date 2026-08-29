import { describe, expect, it } from 'vitest';

import {
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    setNextRecorderPrepareError,
} from './localVoiceEngine.testHarness';

registerLocalVoiceEngineHarnessHooks();

describe('localVoiceEngine capture admission', () => {
    it('fails closed before mic acquisition while Dictation owns capture, then recovers after release', async () => {
        const { voiceCaptureAdmissionController } = await import(
            '@/voice/runtime/input/VoiceCaptureAdmissionController'
        );
        const dictation = voiceCaptureAdmissionController.acquire('dictation');
        if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');

        const {
            getLocalVoiceState,
            stopLocalVoiceSession,
            toggleLocalVoiceTurn,
        } = await loadLocalVoiceEngineWithCompatState();

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState()).toMatchObject({
            error: 'voice_capture_busy_dictation',
        });

        dictation.lease.release();
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState()).toMatchObject({
            sessionId: 's1',
            status: 'recording',
        });

        await stopLocalVoiceSession();
        const recoveredDictation = voiceCaptureAdmissionController.acquire('dictation');
        expect(recoveredDictation.status).toBe('acquired');
        if (recoveredDictation.status === 'acquired') recoveredDictation.lease.release();
    });

    it.each([
        ['permission failure', new Error('mic_permission_denied')],
        ['acquisition failure', new Error('recorder_start_failed')],
    ])('releases admission after %s', async (_label, failure) => {
        setNextRecorderPrepareError(failure);
        const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();
        const { voiceCaptureAdmissionController } = await import(
            '@/voice/runtime/input/VoiceCaptureAdmissionController'
        );

        await toggleLocalVoiceTurn('s1').catch(() => {});

        expect(voiceCaptureAdmissionController.acquire('dictation').status).toBe('acquired');
    });
});

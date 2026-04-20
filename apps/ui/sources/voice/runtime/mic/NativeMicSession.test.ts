import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoAudioRecordingMicSession } from './NativeMicSession';

describe('NativeMicSession', () => {
    const requestPermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
    const showPermissionDenied = vi.fn();
    const stopRecorder = vi.fn(async () => {});
    const pauseRecorder = vi.fn();
    const record = vi.fn();
    const prepareToRecordAsync = vi.fn(async () => {});
    const recorder = {
        uri: 'file:///tmp/rec.m4a' as string | null,
        prepareToRecordAsync,
        record,
        pause: pauseRecorder,
        stop: stopRecorder,
    };
    const createRecorder = vi.fn(() => recorder);

    beforeEach(() => {
        vi.clearAllMocks();
        recorder.uri = 'file:///tmp/rec.m4a';
    });

    it('owns permission and recorder start for recording flows', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();

        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(prepareToRecordAsync).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('tracks muted state and pauses an active recorder until unmuted', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();

        session.setMuted(true);
        expect(session.isMuted()).toBe(true);
        expect(pauseRecorder).toHaveBeenCalledTimes(1);

        session.setMuted(false);
        expect(session.isMuted()).toBe(false);
        expect(record).toHaveBeenCalledTimes(2);
    });

    it('applies mute to recordings that start while the session is already muted', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        session.setMuted(true);
        await session.beginRecording();

        expect(session.isMuted()).toBe(true);
        expect(record).toHaveBeenCalledTimes(1);
        expect(pauseRecorder).toHaveBeenCalledTimes(1);
    });

    it('stops the active recorder and returns the recorded uri', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();
        const uri = await session.stopRecording();

        expect(stopRecorder).toHaveBeenCalledTimes(1);
        expect(uri).toBe('file:///tmp/rec.m4a');
    });
});

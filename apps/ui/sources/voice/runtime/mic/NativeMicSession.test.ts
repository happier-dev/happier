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
    const releaseAudioMode = vi.fn(async () => {});
    const acquireAudioMode = vi.fn(async () => ({ release: releaseAudioMode }));

    beforeEach(() => {
        vi.clearAllMocks();
        recorder.uri = 'file:///tmp/rec.m4a';
        acquireAudioMode.mockResolvedValue({ release: releaseAudioMode });
    });

    it('owns permission and recorder start for recording flows', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await session.beginRecording();

        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(prepareToRecordAsync).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
        expect(acquireAudioMode).toHaveBeenCalledTimes(1);
    });

    it('does not acquire or publish a recorder after permission resolves for an aborted start, and permits retry', async () => {
        let resolvePermission!: (value: {
            granted: boolean;
            canAskAgain: boolean;
        }) => void;
        requestPermission.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePermission = resolve;
        }));
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });
        const abortController = new AbortController();

        const starting = session.beginRecording(abortController.signal);
        await vi.waitFor(() => {
            expect(requestPermission).toHaveBeenCalledTimes(1);
        });
        abortController.abort();
        resolvePermission({ granted: true, canAskAgain: true });
        await starting;

        expect(createRecorder).not.toHaveBeenCalled();
        expect(acquireAudioMode).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();

        await session.beginRecording();
        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(acquireAudioMode).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('tracks muted state and pauses an active recorder until unmuted', async () => {
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
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
            acquireAudioMode,
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
            acquireAudioMode,
        });

        await session.beginRecording();
        const uri = await session.stopRecording();

        expect(stopRecorder).toHaveBeenCalledTimes(1);
        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
        expect(uri).toBe('file:///tmp/rec.m4a');
    });

    it('reads the recorded uri after stop materializes the web recording', async () => {
        recorder.uri = null;
        stopRecorder.mockImplementationOnce(async () => {
            recorder.uri = 'blob:http://localhost/recorded-turn';
        });
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await session.beginRecording();
        const uri = await session.stopRecording();

        expect(uri).toBe('blob:http://localhost/recorded-turn');
        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
    });

    it('releases the audio-session lease when stopping the recorder fails', async () => {
        stopRecorder.mockRejectedValueOnce(new Error('recorder_stop_failed'));
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await session.beginRecording();

        await expect(session.stopRecording()).rejects.toThrow('recorder_stop_failed');
        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
    });

    it('releases the exclusive audio-session lease when recorder preparation fails', async () => {
        prepareToRecordAsync.mockRejectedValueOnce(new Error('recorder_prepare_failed'));
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await expect(session.beginRecording()).rejects.toThrow('recorder_prepare_failed');

        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
        await session.teardown();
        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
    });
});

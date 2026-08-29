import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { createExpoAudioRecordingMicSession, createNativeMicSession } from './NativeMicSession';

describe('NativeMicSession', () => {
    const originalPlatformOs = Platform.OS;
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
        (Platform as { OS: string }).OS = 'android';
        recorder.uri = 'file:///tmp/rec.m4a';
        acquireAudioMode.mockResolvedValue({ release: releaseAudioMode });
    });

    it('owns one native WebRTC microphone stream through mute, teardown, and reacquisition', async () => {
        const releaseFirst = vi.fn();
        const releaseSecond = vi.fn();
        const firstTrack = { enabled: true };
        const secondTrack = { enabled: true };
        const firstStream = {
            getAudioTracks: () => [firstTrack],
            getTracks: () => [firstTrack],
        } as unknown as MediaStream;
        const secondStream = {
            getAudioTracks: () => [secondTrack],
            getTracks: () => [secondTrack],
        } as unknown as MediaStream;
        const acquireStream = vi.fn()
            .mockResolvedValueOnce(firstStream)
            .mockResolvedValueOnce(secondStream);
        const session = createNativeMicSession({
            acquireStream,
            releaseStream: (stream) => {
                if (stream === firstStream) releaseFirst();
                if (stream === secondStream) releaseSecond();
            },
        });

        await session.ensureActive();
        expect(session.getStream()).toBe(firstStream);
        await session.ensureActive();
        expect(acquireStream).toHaveBeenCalledTimes(1);

        session.setMuted(true);
        expect(firstTrack.enabled).toBe(false);
        session.setMuted(false);
        expect(firstTrack.enabled).toBe(true);

        await session.teardown();
        expect(releaseFirst).toHaveBeenCalledTimes(1);
        expect(session.getStream()).toBeNull();

        await session.ensureActive();
        expect(session.getStream()).toBe(secondStream);
        expect(acquireStream).toHaveBeenCalledTimes(2);
        await session.teardown();
        expect(releaseSecond).toHaveBeenCalledTimes(1);
    });

    it('reports a lost native capture track through the lifecycle failure callback', async () => {
        const listeners = new Map<string, Set<() => void>>();
        const track = {
            enabled: true,
            addEventListener: (type: string, listener: () => void) => {
                const set = listeners.get(type) ?? new Set<() => void>();
                set.add(listener);
                listeners.set(type, set);
            },
            removeEventListener: (type: string, listener: () => void) => {
                listeners.get(type)?.delete(listener);
            },
        };
        const stream = {
            getAudioTracks: () => [track],
            getTracks: () => [track],
        } as unknown as MediaStream;
        const onFailure = vi.fn();
        const session = createNativeMicSession({
            onFailure,
            acquireStream: async () => stream,
            releaseStream: () => {},
        });

        await session.ensureActive();
        expect(listeners.get('ended')?.size).toBe(1);

        for (const listener of [...(listeners.get('ended') ?? [])]) listener();

        expect(onFailure).toHaveBeenCalledWith({
            kind: 'mic_ended',
            reason: 'native_mic_track_ended',
        });
        // The lost track is no longer the live capture, so the next attempt
        // re-acquires instead of handing back a dead stream.
        expect(session.getStream()).toBeNull();
    });

    it('does not report a failure for its own teardown, and ignores a retired track that ends later', async () => {
        const listeners = new Map<string, Set<() => void>>();
        const track = {
            enabled: true,
            addEventListener: (type: string, listener: () => void) => {
                const set = listeners.get(type) ?? new Set<() => void>();
                set.add(listener);
                listeners.set(type, set);
            },
            removeEventListener: (type: string, listener: () => void) => {
                listeners.get(type)?.delete(listener);
            },
        };
        const stream = {
            getAudioTracks: () => [track],
            getTracks: () => [track],
        } as unknown as MediaStream;
        const onFailure = vi.fn();
        const session = createNativeMicSession({
            onFailure,
            acquireStream: async () => stream,
            releaseStream: () => {},
        });

        await session.ensureActive();
        const endedListeners = [...(listeners.get('ended') ?? [])];
        await session.teardown();

        // Intentional teardown detaches first, so the platform's own `ended`
        // for the track we just stopped cannot be read as a capture fault.
        expect(listeners.get('ended')?.size ?? 0).toBe(0);
        for (const listener of endedListeners) listener();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('checks native PCM permission without allocating a WebRTC microphone stream', async () => {
        const ensurePermission = vi.fn(async () => undefined);
        const acquireStream = vi.fn(async () => ({
            getAudioTracks: () => [],
            getTracks: () => [],
        }) as unknown as MediaStream);
        const session = createNativeMicSession({ ensurePermission, acquireStream });

        await (session as unknown as Readonly<{ ensurePermission(): Promise<void> }>).ensurePermission();

        expect(ensurePermission).toHaveBeenCalledTimes(1);
        expect(acquireStream).not.toHaveBeenCalled();
        expect(session.getStream()).toBeNull();
    });

    it('deduplicates concurrent acquisition and releases a stream that arrives after teardown', async () => {
        let resolveStream!: (stream: MediaStream) => void;
        const releaseStream = vi.fn();
        const acquiredStream = {
            getAudioTracks: () => [],
            getTracks: () => [],
        } as unknown as MediaStream;
        const acquireStream = vi.fn(() => new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
        }));
        const session = createNativeMicSession({ acquireStream, releaseStream });

        const first = session.ensureActive();
        const second = session.ensureActive();
        await Promise.resolve();
        expect(acquireStream).toHaveBeenCalledTimes(1);

        await session.teardown();
        resolveStream(acquiredStream);
        await Promise.all([first, second]);

        expect(session.getStream()).toBeNull();
        expect(releaseStream).toHaveBeenCalledTimes(1);
        expect(releaseStream).toHaveBeenCalledWith(acquiredStream);
    });

    it('settles teardown and every pending activation when native acquisition never resolves', async () => {
        const releaseStream = vi.fn();
        // The native `getUserMedia` is not abortable. End Voice must still
        // complete: teardown takes ownership of the lifecycle instead of
        // joining an acquisition the platform may never settle.
        const acquireStream = vi.fn(() => new Promise<MediaStream>(() => {}));
        const session = createNativeMicSession({ acquireStream, releaseStream });

        const first = session.ensureActive();
        const second = session.ensureActive();
        await Promise.resolve();
        expect(acquireStream).toHaveBeenCalledTimes(1);

        let activationSettled = false;
        void Promise.all([first, second]).then(() => { activationSettled = true; });

        await session.teardown();
        for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

        expect(activationSettled).toBe(true);
        expect(session.getStream()).toBeNull();
        expect(releaseStream).not.toHaveBeenCalled();
    });

    afterEach(() => {
        (Platform as { OS: string }).OS = originalPlatformOs;
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

    it('uses the coordinator-owned native file recorder on iOS and never constructs Expo Audio', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const nativeStart = vi.fn(async () => {});
        const nativeSetMuted = vi.fn(async () => {});
        const nativeStop = vi.fn(async () => 'file:///tmp/native-rec.m4a');
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            createNativeFileRecording: () => ({
                start: nativeStart,
                setMuted: nativeSetMuted,
                stop: nativeStop,
            }),
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await session.beginRecording();
        session.setMuted(true);
        const uri = await session.stopRecording();

        expect(createRecorder).not.toHaveBeenCalled();
        expect(nativeStart).toHaveBeenCalledOnce();
        expect(nativeSetMuted).toHaveBeenCalledWith(true);
        expect(nativeStop).toHaveBeenCalledOnce();
        expect(uri).toBe('file:///tmp/native-rec.m4a');
        expect(releaseAudioMode).toHaveBeenCalledOnce();
    });

    it('fails closed on iOS when the paired native module lacks file recording', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            createNativeFileRecording: () => null,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await expect(session.beginRecording()).rejects.toThrow('voice_native_file_recording_unavailable');

        expect(createRecorder).not.toHaveBeenCalled();
        expect(releaseAudioMode).toHaveBeenCalledOnce();
    });

    it('lets the web recorder own its single microphone acquisition without a permission-probe stream', async () => {
        (Platform as { OS: string }).OS = 'web';
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await session.beginRecording();

        expect(requestPermission).not.toHaveBeenCalled();
        expect(prepareToRecordAsync).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('maps a web recorder permission rejection back to the recording permission contract', async () => {
        (Platform as { OS: string }).OS = 'web';
        prepareToRecordAsync.mockRejectedValueOnce(
            Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
        );
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
        });

        await expect(session.beginRecording()).rejects.toThrow('mic_permission_denied');

        expect(requestPermission).not.toHaveBeenCalled();
        expect(showPermissionDenied).toHaveBeenCalledWith(false);
        expect(releaseAudioMode).toHaveBeenCalledTimes(1);
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

    it('deletes one concrete artifact from a native start that settles after cancellation and teardown without touching retry', async () => {
        (Platform as { OS: string }).OS = 'ios';
        let resolveLateStart!: () => void;
        const lateStart = new Promise<void>((resolve) => {
            resolveLateStart = resolve;
        });
        const staleStop = vi.fn(async () => 'file:///tmp/stale-after-cancel.m4a');
        const retryStop = vi.fn(async () => 'file:///tmp/retry.m4a');
        const createNativeFileRecording = vi.fn()
            .mockReturnValueOnce({
                start: vi.fn(() => lateStart),
                setMuted: vi.fn(async () => {}),
                stop: staleStop,
            })
            .mockReturnValueOnce({
                start: vi.fn(async () => {}),
                setMuted: vi.fn(async () => {}),
                stop: retryStop,
            });
        const deleteRecordedAudio = vi.fn(async () => {});
        const session = createExpoAudioRecordingMicSession({
            createRecorder,
            createNativeFileRecording,
            requestPermission,
            showPermissionDenied,
            acquireAudioMode,
            deleteRecordedAudio,
        });
        const abortController = new AbortController();

        const starting = session.beginRecording(abortController.signal);
        await vi.waitFor(() => expect(createNativeFileRecording).toHaveBeenCalledTimes(1));
        abortController.abort();
        await session.teardown();
        resolveLateStart();
        await starting;

        expect(staleStop).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///tmp/stale-after-cancel.m4a');

        await session.beginRecording();
        await expect(session.stopRecording()).resolves.toBe('file:///tmp/retry.m4a');
        expect(retryStop).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
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

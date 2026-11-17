import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { createDeferred } from '@/dev/testkit';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
// The installed native module and package registry have one identity per app
// process. Observe/reset SDK operations, never replace the registry's getter.
const nativeAudio = createNativeVoicePcmCaptureHarness();
vi.mock('expo-modules-core', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
        ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});
vi.mock('expo-audio', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-audio')>();
    return { ...actual, AudioModule: { ...actual.AudioModule, setAudioModeAsync: vi.fn(async () => {}) } };
});
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    async delete() { this.exists = false; }
} }));

const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createVoiceFileRecording, getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const coordinator = getSharedVoiceAudioSessionCoordinator();
if (!coordinator) throw new Error('Installed native audio SDK coordination unavailable');
const audioSession = { nativeModule: nativeAudio.nativeModule, coordinator };
const { createExpoAudioRecordingMicSession, createNativeMicSession } = await import('./NativeMicSession');
afterAll(async () => {
    await coordinator.dispose();
    await nativeAudio.coordinator.dispose();
});

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
    const recordingSessions: Array<ReturnType<typeof createExpoAudioRecordingMicSession>> = [];
    function createRecordingSession(options: Parameters<typeof createExpoAudioRecordingMicSession>[0]) {
        const session = createExpoAudioRecordingMicSession(options);
        recordingSessions.push(session);
        return session;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (Platform as { OS: string }).OS = 'android';
        recorder.uri = 'file:///tmp/rec.m4a';
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

    afterEach(async () => {
        for (const session of recordingSessions.splice(0)) await session.teardown();
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
        (Platform as { OS: string }).OS = originalPlatformOs;
    });

    it('owns permission and recorder start for recording flows', async () => {
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();

        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(prepareToRecordAsync).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(1);
    });

    it('uses the coordinator-owned native file recorder on iOS and never constructs Expo Audio', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const nativeStart = vi.fn(async () => {});
        const nativeSetMuted = vi.fn(async (_muted: boolean) => {});
        const nativeStop = vi.fn(async () => 'file:///tmp/native-rec.m4a');
        const session = createRecordingSession({
            createRecorder,
            createNativeFileRecording: () => createVoiceFileRecording({ ...audioSession.nativeModule,
                startFileRecording: async () => { await nativeStart(); return { recordingId: 'native-file' }; },
                setFileRecordingMuted: async ({ muted }) => { await nativeSetMuted(muted); },
                stopFileRecording: async () => ({ uri: await nativeStop() }),
            }),
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();
        session.setMuted(true);
        const uri = await session.stopRecording();

        expect(createRecorder).not.toHaveBeenCalled();
        expect(nativeStart).toHaveBeenCalledOnce();
        expect(nativeSetMuted).toHaveBeenCalledWith(true);
        expect(nativeStop).toHaveBeenCalledOnce();
        expect(uri).toBe('file:///tmp/native-rec.m4a');
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('fails closed on iOS when the paired native module lacks file recording', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const session = createRecordingSession({
            createRecorder,
            createNativeFileRecording: () => createVoiceFileRecording(audioSession.nativeModule),
            requestPermission,
            showPermissionDenied,
        });

        await expect(session.beginRecording()).rejects.toThrow('voice_native_file_recording_unavailable');

        expect(createRecorder).not.toHaveBeenCalled();
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('lets the web recorder own its single microphone acquisition without a permission-probe stream', async () => {
        (Platform as { OS: string }).OS = 'web';
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
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
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await expect(session.beginRecording()).rejects.toThrow('mic_permission_denied');

        expect(requestPermission).not.toHaveBeenCalled();
        expect(showPermissionDenied).toHaveBeenCalledWith(false);
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('does not acquire or publish a recorder after permission resolves for an aborted start, and permits retry', async () => {
        let resolvePermission!: (value: {
            granted: boolean;
            canAskAgain: boolean;
        }) => void;
        const permissionEntered = createDeferred<void>();
        requestPermission.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePermission = resolve;
            permissionEntered.resolve();
        }));
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });
        const abortController = new AbortController();

        const starting = session.beginRecording(abortController.signal);
        await permissionEntered.promise;
        expect(requestPermission).toHaveBeenCalledTimes(1);
        abortController.abort();
        resolvePermission({ granted: true, canAskAgain: true });
        await starting;

        expect(createRecorder).not.toHaveBeenCalled();
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
        expect(record).not.toHaveBeenCalled();

        await session.beginRecording();
        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(1);
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
        const nativeStartEntered = createDeferred<void>();
        const nativeFileStart = vi.fn()
            .mockImplementationOnce(async () => { nativeStartEntered.resolve(); await lateStart; return { recordingId: 'stale' }; })
            .mockResolvedValueOnce({ recordingId: 'retry' });
        const nativeFileModule = { ...audioSession.nativeModule,
            startFileRecording: nativeFileStart,
            setFileRecordingMuted: async () => {},
            stopFileRecording: async ({ recordingId }: { recordingId: string }) => ({
                uri: recordingId === 'stale' ? await staleStop() : await retryStop(),
            }),
        };
        const createNativeFileRecording = () => createVoiceFileRecording(nativeFileModule);
        const deleteRecordedAudio = vi.fn(async () => {});
        const session = createRecordingSession({
            createRecorder,
            createNativeFileRecording,
            requestPermission,
            showPermissionDenied,
            deleteRecordedAudio,
        });
        const abortController = new AbortController();

        const starting = session.beginRecording(abortController.signal);
        await nativeStartEntered.promise;
        expect(nativeFileStart).toHaveBeenCalledTimes(1);
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

    it.each(['android', 'ios'])('releases pending %s recording custody on teardown and fences late completion from a retry', async (platform) => {
        (Platform as { OS: string }).OS = platform;
        let finishPreparation!: () => void;
        const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
        const preparationEntered = createDeferred<void>();
        const firstRecorder = { ...recorder, prepareToRecordAsync: vi.fn(() => { preparationEntered.resolve(); return preparation; }), record: vi.fn(), stop: vi.fn(async () => {}) };
        const retryRecorder = { ...recorder, record: vi.fn(), stop: vi.fn(async () => {}) };
        const nativeStart = vi.fn()
            .mockImplementationOnce(async () => { preparationEntered.resolve(); await preparation; return { recordingId: 'pending' }; })
            .mockResolvedValueOnce({ recordingId: 'retry' });
        const nativeStop = vi.fn(async ({ recordingId }: { recordingId: string }) => ({ uri: `file:///tmp/${recordingId}.m4a` }));
        const session = createRecordingSession({
            requestPermission,
            createRecorder: vi.fn().mockReturnValueOnce(firstRecorder).mockReturnValueOnce(retryRecorder),
            createNativeFileRecording: () => createVoiceFileRecording({ ...audioSession.nativeModule,
                startFileRecording: nativeStart,
                setFileRecordingMuted: async () => {},
                stopFileRecording: nativeStop,
            }),
            deleteRecordedAudio: vi.fn(async () => {}),
        });
        const starting = session.beginRecording();
        try {
            await preparationEntered.promise;
            expect(platform === 'ios' ? nativeStart : firstRecorder.prepareToRecordAsync).toHaveBeenCalledOnce();
            await session.teardown();
            expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
            await session.beginRecording();
            expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(1);
            finishPreparation();
            await starting;
            expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(1);
            expect(firstRecorder.record).not.toHaveBeenCalled();
            expect(retryRecorder.stop).not.toHaveBeenCalled();
            await expect(session.stopRecording()).resolves.toBe(platform === 'ios' ? 'file:///tmp/retry.m4a' : 'file:///tmp/rec.m4a');
            if (platform === 'ios') expect(nativeStop.mock.calls.map(([args]) => args.recordingId)).toEqual(['pending', 'retry']);
            else expect(firstRecorder.stop).toHaveBeenCalledOnce();
        } finally {
            finishPreparation();
            await starting;
        }
    });

    it('tracks muted state and pauses an active recorder until unmuted', async () => {
        const session = createRecordingSession({
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

    it('keeps recorded input muted until native resume acknowledges success', async () => {
        (Platform as { OS: string }).OS = 'ios';
        let rejectResume!: (error: Error) => void;
        const resume = new Promise<void>((_resolve, reject) => { rejectResume = reject; });
        const resumeEntered = createDeferred<void>();
        const nativeMute = vi.fn(async ({ muted }: { muted: boolean }) => { if (!muted) { resumeEntered.resolve(); await resume; } });
        const session = createRecordingSession({
            requestPermission,
            createNativeFileRecording: () => createVoiceFileRecording({ ...audioSession.nativeModule,
                startFileRecording: async () => ({ recordingId: 'mute-ack' }),
                setFileRecordingMuted: nativeMute,
                stopFileRecording: async () => ({ uri: 'file:///tmp/mute-ack.m4a' }),
            }),
        });
        await session.beginRecording();
        await session.setMuted(true);
        let settled = false;
        const outcome = Promise.resolve(session.setMuted(false)).then(
            () => { settled = true; return null; },
            error => { settled = true; return error; },
        );
        await resumeEntered.promise;
        expect(nativeMute).toHaveBeenCalledWith({ recordingId: 'mute-ack', muted: false });
        try {
            expect(settled).toBe(false);
            expect(session.isMuted()).toBe(true);
        } finally {
            rejectResume(new Error('file_recording_resume_failed'));
        }
        await expect(outcome).resolves.toMatchObject({ message: 'file_recording_resume_failed' });
        expect(session.isMuted()).toBe(true);
    });

    it('applies mute to recordings that start while the session is already muted', async () => {
        const session = createRecordingSession({
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
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();
        const uri = await session.stopRecording();

        expect(stopRecorder).toHaveBeenCalledTimes(1);
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
        expect(uri).toBe('file:///tmp/rec.m4a');
    });

    it('reads the recorded uri after stop materializes the web recording', async () => {
        recorder.uri = null;
        stopRecorder.mockImplementationOnce(async () => {
            recorder.uri = 'blob:http://localhost/recorded-turn';
        });
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();
        const uri = await session.stopRecording();

        expect(uri).toBe('blob:http://localhost/recorded-turn');
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('releases the audio-session lease when stopping the recorder fails', async () => {
        stopRecorder.mockRejectedValueOnce(new Error('recorder_stop_failed'));
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await session.beginRecording();

        await expect(session.stopRecording()).rejects.toThrow('recorder_stop_failed');
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
        // Releasing the audio-mode lease is not an acknowledgement that the
        // physical recorder stopped. Its same handle remains available to retry.
        await expect(session.stopRecording()).resolves.toBe('file:///tmp/rec.m4a');
        expect(stopRecorder).toHaveBeenCalledTimes(2);
    });

    it('releases the exclusive audio-session lease when recorder preparation fails', async () => {
        prepareToRecordAsync.mockRejectedValueOnce(new Error('recorder_prepare_failed'));
        const session = createRecordingSession({
            createRecorder,
            requestPermission,
            showPermissionDenied,
        });

        await expect(session.beginRecording()).rejects.toThrow('recorder_prepare_failed');

        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
        await session.teardown();
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });
});

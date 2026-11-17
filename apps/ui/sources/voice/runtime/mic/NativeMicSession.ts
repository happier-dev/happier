import { Platform } from 'react-native';
import {
    createVoiceFileRecording,
    type VoiceFileRecording,
} from '@happier-dev/audio-stream-native';

import {
    isPermissionDeniedMicrophoneError,
    rejectRefusedMicrophone,
    requestMicrophonePermission,
    showMicrophonePermissionDeniedAlert,
} from '@/utils/platform/microphonePermissions';

import type { CreateMicSessionOptions, MicSession } from './MicSession';
import {
    createExpoAudioRecorder,
    type ExpoAudioRecorderLike,
} from './createExpoAudioRecorder';
import {
    acquireVoiceForegroundRecordingAudioMode,
    type VoiceAudioModeLease,
} from '@/voice/runtime/voiceAudioMode';
import {
    createMicLifecycleInvalidation,
    joinMicAcquisition,
    type MicAcquisitionAttempt,
} from './micAcquisitionLifecycle';
import {
    createRecordedAudioArtifactCleanup,
    deleteRecordedAudioArtifact,
} from '@/voice/runtime/input/recordedAudioArtifactCleanup';

type CreateNativeMicSessionOptions = Readonly<{
    ensurePermission?: () => Promise<void>;
    ensureActive?: () => Promise<void>;
    acquireStream?: () => Promise<MediaStream>;
    releaseStream?: (stream: MediaStream) => Promise<void> | void;
    setMuted?: (muted: boolean) => Promise<void> | void;
    teardown?: () => Promise<void>;
}> & Pick<CreateMicSessionOptions, 'onFailure'>;

type RecordingPermissionResult = Readonly<{
    granted: boolean;
    canAskAgain: boolean;
}>;

type RecordingMicSession = Omit<MicSession, 'teardown'> & Readonly<{
    /** Outstanding physical recording custody, including a native start still awaiting acknowledgement. */
    hasUnretiredRecording: () => boolean;
    teardown: (options?: Readonly<{ mode: 'read_aloud' }>) => Promise<void>;
    beginRecording: (signal?: AbortSignal) => Promise<void>;
    stopRecording: () => Promise<string | null>;
}>;

type CreateExpoAudioRecordingMicSessionOptions = Readonly<{
    createRecorder?: () => ExpoAudioRecorderLike;
    requestPermission?: () => Promise<RecordingPermissionResult>;
    showPermissionDenied?: (canAskAgain: boolean) => void;
    acquireAudioMode?: () => Promise<VoiceAudioModeLease>;
    createNativeFileRecording?: () => VoiceFileRecording | null;
    deleteRecordedAudio?: (uri: string) => Promise<void>;
}>;

export function createNativeMicSession(options: CreateNativeMicSessionOptions = {}): MicSession {
    let muted = false;
    let stream: MediaStream | null = null;
    let activation: MicAcquisitionAttempt | null = null;
    let lifecycleEpoch = 0;
    let lifecycleInvalidated = createMicLifecycleInvalidation();
    let activeTrack: MediaStreamTrack | null = null;
    let trackEndedListener: (() => void) | null = null;

    /**
     * Detach before any intentional retirement. The platform fires `ended` for a
     * track we stopped ourselves, and reading that as a capture fault would fail
     * every ordinary Stop.
     */
    const detachTrackListeners = (): void => {
        const track = activeTrack;
        const listener = trackEndedListener;
        activeTrack = null;
        trackEndedListener = null;
        if (!track || !listener) return;
        track.removeEventListener('ended', listener);
    };

    const attachTrackListeners = (activeStream: MediaStream): void => {
        detachTrackListeners();
        const [track] = activeStream.getAudioTracks();
        if (!track || typeof track.addEventListener !== 'function') return;
        const attachedEpoch = lifecycleEpoch;
        const listener = (): void => {
            // A track that ends after its lifecycle was retired belongs to a
            // superseded attempt; only the current capture can fail the runtime.
            if (attachedEpoch !== lifecycleEpoch || activeTrack !== track) return;
            detachTrackListeners();
            if (stream === activeStream) stream = null;
            options.onFailure?.({ kind: 'mic_ended', reason: 'native_mic_track_ended' });
        };
        activeTrack = track;
        trackEndedListener = listener;
        track.addEventListener('ended', listener);
    };

    const releaseStream = async (activeStream: MediaStream): Promise<void> => {
        if (options.releaseStream) {
            await options.releaseStream(activeStream);
            return;
        }
        for (const track of activeStream.getTracks()) track.stop();
    };

    const applyMutedState = (activeStream: MediaStream): void => {
        for (const track of activeStream.getAudioTracks()) track.enabled = !muted;
    };
    const ensurePermission = options.ensurePermission ?? options.ensureActive;

    return {
        ensurePermission: async () => {
            await ensurePermission?.();
        },
        ensureActive: async () => {
            if (stream) return;
            if (activation) {
                await joinMicAcquisition(activation, lifecycleInvalidated);
                return;
            }
            const startEpoch = lifecycleEpoch;
            const acquire = (async () => {
                await ensurePermission?.();
                const acquired = await options.acquireStream?.();
                if (!acquired) return;
                if (lifecycleEpoch !== startEpoch) {
                    await releaseStream(acquired);
                    return;
                }
                applyMutedState(acquired);
                stream = acquired;
                attachTrackListeners(acquired);
            })();
            const nextActivation: MicAcquisitionAttempt = {
                outcome: acquire.then(() => null, (error: unknown) => ({ error })),
            };
            activation = nextActivation;
            try {
                await joinMicAcquisition(nextActivation, lifecycleInvalidated);
            } finally {
                if (activation === nextActivation) activation = null;
            }
        },
        setMuted: (nextMuted) => {
            muted = nextMuted;
            if (stream) applyMutedState(stream);
            void options.setMuted?.(nextMuted);
        },
        isMuted: () => muted,
        teardown: async () => {
            lifecycleEpoch += 1;
            // Ownership moves here, so an outstanding acquisition is abandoned
            // rather than joined: the epoch bump makes a late native stream
            // release itself, and its rejection is already consumed by the
            // attempt outcome. Native `getUserMedia` is not abortable, so
            // joining it would make End Voice wait on a promise only the
            // platform can settle.
            activation = null;
            lifecycleInvalidated.invalidate();
            lifecycleInvalidated = createMicLifecycleInvalidation();
            detachTrackListeners();
            const activeStream = stream;
            stream = null;
            if (activeStream) await releaseStream(activeStream);
            await options.teardown?.();
        },
        getStream: () => stream,
    };
}

export function createExpoAudioRecordingMicSession(
    options: CreateExpoAudioRecordingMicSessionOptions = {},
): RecordingMicSession {
    let recorder: ExpoAudioRecorderLike | null = null;
    let nativeFileRecording: VoiceFileRecording | null = null;
    type NativeRecordingAttempt = {
        recording: VoiceFileRecording;
        started: Promise<void>;
        retiring?: Promise<void>;
    };
    // End may admit another start while an uncancellable native start is still
    // pending. Keep each actual resource until native stop acknowledges it.
    const nativeRecordingAttempts = new Set<NativeRecordingAttempt>();
    let audioModeLease: VoiceAudioModeLease | null = null;
    let muted = false;
    const requestPermission = options.requestPermission ?? requestMicrophonePermission;
    const showPermissionDenied = options.showPermissionDenied ?? showMicrophonePermissionDeniedAlert;
    const createRecorder =
        options.createRecorder
        ?? createExpoAudioRecorder;
    const acquireAudioMode = options.acquireAudioMode
        ?? (() => acquireVoiceForegroundRecordingAudioMode(
            Platform.OS === 'ios' ? 'native-file-recorder' : 'expo-audio-recorder',
        ));
    const createNativeRecording = options.createNativeFileRecording ?? createVoiceFileRecording;
    const deleteRecordedAudio = options.deleteRecordedAudio ?? deleteRecordedAudioArtifact;

    const discardTerminalArtifact = async (uri: string | null): Promise<void> => {
        const cleanup = createRecordedAudioArtifactCleanup(deleteRecordedAudio);
        cleanup.admit(uri);
        const result = await cleanup.cleanup();
        if (result.kind === 'failed') throw result.error;
    };

    const retireNativeRecording = (attempt: NativeRecordingAttempt): Promise<void> => {
        if (attempt.retiring) return attempt.retiring;
        const retiring = (async () => {
            await attempt.started;
            const uri = await attempt.recording.stop();
            nativeRecordingAttempts.delete(attempt);
            if (nativeFileRecording === attempt.recording) nativeFileRecording = null;
            // Artifact deletion failure is observable, but cannot turn an
            // acknowledged native stop back into physical microphone custody.
            await discardTerminalArtifact(uri);
        })().finally(() => {
            if (attempt.retiring === retiring) attempt.retiring = undefined;
        });
        attempt.retiring = retiring;
        return retiring;
    };

    const releaseAudioMode = async (activeLease = audioModeLease): Promise<void> => {
        if (!activeLease) return;
        await activeLease.release();
        if (audioModeLease === activeLease) audioModeLease = null;
    };

    return {
        ensureActive: async () => {
            rejectRefusedMicrophone(await requestPermission(), showPermissionDenied);
        },
        setMuted: async (nextMuted) => {
            if (muted === nextMuted) {
                return;
            }

            if (nativeFileRecording) {
                await nativeFileRecording.setMuted(nextMuted);
            } else if (recorder) {
                // Expo acknowledges pause/resume synchronously at this seam.
                if (nextMuted) recorder.pause();
                else recorder.record();
            }
            muted = nextMuted;
        },
        isMuted: () => muted,
        hasUnretiredRecording: () => nativeRecordingAttempts.size > 0 || recorder !== null,
        teardown: async (options) => {
            const retiringAudioModeLease = audioModeLease;
            if (audioModeLease === retiringAudioModeLease) audioModeLease = null;
            // Invalidate pending preparation before joining physical retirement.
            // Expo checks this lease before record(); native start is not abortable.
            try {
                if (options?.mode === 'read_aloud') {
                    await Promise.all([...nativeRecordingAttempts].map(retireNativeRecording));
                } else {
                    const active = [...nativeRecordingAttempts].find(attempt => attempt.recording === nativeFileRecording);
                    if (active) await retireNativeRecording(active);
                }
                const activeRecorder = recorder;
                if (activeRecorder) {
                    await activeRecorder.stop();
                    if (recorder === activeRecorder) recorder = null;
                    await discardTerminalArtifact(activeRecorder.uri ?? null);
                }
            } catch (error) {
                // End remains best-effort. Read aloud needs acknowledged physical
                // retirement, and a rejected stop retains the same handle to retry.
                if (options?.mode === 'read_aloud') throw error;
            } finally {
                await releaseAudioMode(retiringAudioModeLease);
            }
        },
        getStream: () => null,
        beginRecording: async (signal) => {
            if (Platform.OS !== 'web') {
                const permission = await requestPermission();
                if (signal?.aborted) {
                    return;
                }
                rejectRefusedMicrophone(permission, showPermissionDenied);
            }
            const nextAudioModeLease = await acquireAudioMode();
            if (signal?.aborted) {
                await nextAudioModeLease.release();
                return;
            }
            // Teardown must own the lease while the platform prepares capture,
            // even when that preparation never settles. Its identity also fences
            // a late recorder from publishing over a subsequent recording.
            audioModeLease = nextAudioModeLease;
            try {
                if (Platform.OS === 'ios') {
                    const nextNativeRecording = createNativeRecording();
                    if (!nextNativeRecording) {
                        throw new Error('voice_native_file_recording_unavailable');
                    }
                    const attempt: NativeRecordingAttempt = {
                        recording: nextNativeRecording,
                        started: nextNativeRecording.start(),
                    };
                    nativeRecordingAttempts.add(attempt);
                    try {
                        try {
                            await attempt.started;
                        } catch (error) {
                            nativeRecordingAttempts.delete(attempt);
                            throw error;
                        }
                        if (!signal?.aborted && audioModeLease === nextAudioModeLease && muted) {
                            await nextNativeRecording.setMuted(true);
                        }
                        if (signal?.aborted || audioModeLease !== nextAudioModeLease) {
                            await retireNativeRecording(attempt);
                            await releaseAudioMode(nextAudioModeLease);
                            return;
                        }
                    } catch (error) {
                        // A failed rollback remains owned for a strict retirement
                        // retry; never erase its native handle or hide that failure.
                        if (nativeRecordingAttempts.has(attempt) && !signal?.aborted) {
                            await retireNativeRecording(attempt);
                        }
                        throw error;
                    }
                    nativeFileRecording = nextNativeRecording;
                    return;
                }
                const nextRecorder = createRecorder();
                await nextRecorder.prepareToRecordAsync();
                if (signal?.aborted || audioModeLease !== nextAudioModeLease) {
                    try {
                        await nextRecorder.stop();
                        await discardTerminalArtifact(nextRecorder.uri ?? null);
                    } catch {
                        // Preparation rollback is best-effort; releasing the
                        // attempt-local audio-mode lease remains authoritative.
                    }
                    await releaseAudioMode(nextAudioModeLease);
                    return;
                }
                nextRecorder.record();
                recorder = nextRecorder;
                if (muted) {
                    nextRecorder.pause();
                }
            } catch (error) {
                await releaseAudioMode(nextAudioModeLease);
                if (Platform.OS === 'web' && isPermissionDeniedMicrophoneError(error)) {
                    showPermissionDenied(false);
                    throw new Error('mic_permission_denied');
                }
                throw error;
            }
        },
        stopRecording: async () => {
            const retiringAudioModeLease = audioModeLease;
            const activeNativeRecording = nativeFileRecording;
            const activeRecorder = recorder;
            try {
                if (activeNativeRecording) {
                    const uri = await activeNativeRecording.stop();
                    if (nativeFileRecording === activeNativeRecording) nativeFileRecording = null;
                    for (const attempt of nativeRecordingAttempts) {
                        if (attempt.recording === activeNativeRecording) nativeRecordingAttempts.delete(attempt);
                    }
                    return uri;
                }
                if (!activeRecorder) return null;
                await activeRecorder.stop();
                if (recorder === activeRecorder) recorder = null;
                // Expo Audio's web recorder creates its Blob URL while stop()
                // finalizes the MediaRecorder. Reading `uri` before that await
                // silently drops valid browser recordings and skips STT.
                return activeRecorder.uri ?? null;
            } finally {
                await releaseAudioMode(retiringAudioModeLease);
            }
        },
    };
}

export type { RecordingMicSession };

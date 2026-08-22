import { Platform } from 'react-native';

import {
    isPermissionDeniedMicrophoneError,
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

type RecordingMicSession = MicSession & Readonly<{
    beginRecording: (signal?: AbortSignal) => Promise<void>;
    stopRecording: () => Promise<string | null>;
}>;

type CreateExpoAudioRecordingMicSessionOptions = Readonly<{
    createRecorder?: () => ExpoAudioRecorderLike;
    requestPermission?: () => Promise<RecordingPermissionResult>;
    showPermissionDenied?: (canAskAgain: boolean) => void;
    acquireAudioMode?: () => Promise<VoiceAudioModeLease>;
}>;

export function createNativeMicSession(options: CreateNativeMicSessionOptions = {}): MicSession {
    let muted = false;
    let stream: MediaStream | null = null;
    let activation: Promise<void> | null = null;
    let lifecycleEpoch = 0;
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
            if (activation) return await activation;
            const startEpoch = lifecycleEpoch;
            const nextActivation = (async () => {
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
            activation = nextActivation;
            try {
                await nextActivation;
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
    let audioModeLease: VoiceAudioModeLease | null = null;
    let muted = false;
    const requestPermission = options.requestPermission ?? requestMicrophonePermission;
    const showPermissionDenied = options.showPermissionDenied ?? showMicrophonePermissionDeniedAlert;
    const createRecorder =
        options.createRecorder
        ?? createExpoAudioRecorder;
    const acquireAudioMode = options.acquireAudioMode
        ?? (() => acquireVoiceForegroundRecordingAudioMode('expo-audio-recorder'));

    const releaseAudioMode = async (): Promise<void> => {
        const activeLease = audioModeLease;
        if (!activeLease) return;
        await activeLease.release();
        if (audioModeLease === activeLease) audioModeLease = null;
    };

    const syncRecorderMuteState = (activeRecorder: ExpoAudioRecorderLike | null): void => {
        if (!activeRecorder) {
            return;
        }

        // Expo's recorder does not expose a dedicated mute API; pause/resume is the recorder-level seam.
        if (muted) {
            activeRecorder.pause();
            return;
        }

        activeRecorder.record();
    };

    return {
        ensureActive: async () => {
            const permission = await requestPermission();
            if (!permission.granted) {
                showPermissionDenied(permission.canAskAgain === true);
                throw new Error('mic_permission_denied');
            }
        },
        setMuted: (nextMuted) => {
            if (muted === nextMuted) {
                return;
            }

            muted = nextMuted;
            syncRecorderMuteState(recorder);
        },
        isMuted: () => muted,
        teardown: async () => {
            const activeRecorder = recorder;
            recorder = null;
            if (activeRecorder) {
                try {
                    await activeRecorder.stop();
                } catch {
                    // Recorder teardown is best-effort; the audio-session lease
                    // must still be restored by its canonical owner.
                }
            }
            await releaseAudioMode();
        },
        getStream: () => null,
        beginRecording: async (signal) => {
            if (Platform.OS !== 'web') {
                const permission = await requestPermission();
                if (signal?.aborted) {
                    return;
                }
                if (!permission.granted) {
                    showPermissionDenied(permission.canAskAgain === true);
                    throw new Error('mic_permission_denied');
                }
            }
            const nextRecorder = createRecorder();
            const nextAudioModeLease = await acquireAudioMode();
            if (signal?.aborted) {
                await nextAudioModeLease.release();
                return;
            }
            try {
                await nextRecorder.prepareToRecordAsync();
                if (signal?.aborted) {
                    try {
                        await nextRecorder.stop();
                    } catch {
                        // Preparation rollback is best-effort; releasing the
                        // attempt-local audio-mode lease remains authoritative.
                    }
                    await nextAudioModeLease.release();
                    return;
                }
                audioModeLease = nextAudioModeLease;
                nextRecorder.record();
                recorder = nextRecorder;
                if (muted) {
                    nextRecorder.pause();
                }
            } catch (error) {
                await nextAudioModeLease.release();
                if (Platform.OS === 'web' && isPermissionDeniedMicrophoneError(error)) {
                    showPermissionDenied(false);
                    throw new Error('mic_permission_denied');
                }
                throw error;
            }
        },
        stopRecording: async () => {
            const activeRecorder = recorder;
            recorder = null;
            try {
                if (!activeRecorder) return null;
                await activeRecorder.stop();
                // Expo Audio's web recorder creates its Blob URL while stop()
                // finalizes the MediaRecorder. Reading `uri` before that await
                // silently drops valid browser recordings and skips STT.
                return activeRecorder.uri ?? null;
            } finally {
                await releaseAudioMode();
            }
        },
    };
}

export type { RecordingMicSession };

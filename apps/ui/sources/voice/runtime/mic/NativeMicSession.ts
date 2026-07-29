import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import type { MicSession } from './MicSession';
import {
    createExpoAudioRecorder,
    type ExpoAudioRecorderLike,
} from './createExpoAudioRecorder';
import {
    acquireVoiceForegroundRecordingAudioMode,
    type VoiceAudioModeLease,
} from '@/voice/runtime/voiceAudioMode';

type CreateNativeMicSessionOptions = Readonly<{
    ensureActive?: () => Promise<void>;
    setMuted?: (muted: boolean) => Promise<void> | void;
    teardown?: () => Promise<void>;
}>;

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

    return {
        ensureActive: async () => {
            await options.ensureActive?.();
        },
        setMuted: (nextMuted) => {
            muted = nextMuted;
            void options.setMuted?.(nextMuted);
        },
        isMuted: () => muted,
        teardown: async () => {
            await options.teardown?.();
        },
        getStream: () => null,
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
            const permission = await requestPermission();
            if (signal?.aborted) {
                return;
            }
            if (!permission.granted) {
                showPermissionDenied(permission.canAskAgain === true);
                throw new Error('mic_permission_denied');
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

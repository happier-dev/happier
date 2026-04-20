import { AudioModule, RecordingPresets } from 'expo-audio';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import type { MicSession } from './MicSession';

type CreateNativeMicSessionOptions = Readonly<{
    ensureActive?: () => Promise<void>;
    setMuted?: (muted: boolean) => Promise<void> | void;
    teardown?: () => Promise<void>;
}>;

type RecorderLike = Readonly<{
    uri: string | null;
    prepareToRecordAsync: () => Promise<void>;
    pause: () => void;
    record: () => void;
    stop: () => Promise<void>;
}>;

type RecordingPermissionResult = Readonly<{
    granted: boolean;
    canAskAgain: boolean;
}>;

type RecordingMicSession = MicSession & Readonly<{
    beginRecording: () => Promise<void>;
    stopRecording: () => Promise<string | null>;
}>;

type CreateExpoAudioRecordingMicSessionOptions = Readonly<{
    createRecorder?: () => RecorderLike;
    requestPermission?: () => Promise<RecordingPermissionResult>;
    showPermissionDenied?: (canAskAgain: boolean) => void;
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
    let recorder: RecorderLike | null = null;
    let muted = false;
    const requestPermission = options.requestPermission ?? requestMicrophonePermission;
    const showPermissionDenied = options.showPermissionDenied ?? showMicrophonePermissionDeniedAlert;
    const createRecorder =
        options.createRecorder
        ?? (() => new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY) as unknown as RecorderLike);

    const syncRecorderMuteState = (activeRecorder: RecorderLike | null): void => {
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
            if (!recorder) return;
            try {
                await recorder.stop();
            } catch {
                // best-effort
            } finally {
                recorder = null;
            }
        },
        getStream: () => null,
        beginRecording: async () => {
            const permission = await requestPermission();
            if (!permission.granted) {
                showPermissionDenied(permission.canAskAgain === true);
                throw new Error('mic_permission_denied');
            }
            const nextRecorder = createRecorder();
            await nextRecorder.prepareToRecordAsync();
            nextRecorder.record();
            recorder = nextRecorder;
            if (muted) {
                nextRecorder.pause();
            }
        },
        stopRecording: async () => {
            const activeRecorder = recorder;
            recorder = null;
            if (!activeRecorder) return null;
            await activeRecorder.stop();
            return activeRecorder.uri;
        },
    };
}

export type { RecordingMicSession };

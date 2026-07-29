import { AudioModule, RecordingPresets } from 'expo-audio';
import { Platform } from 'react-native';

export type ExpoAudioRecorderLike = Readonly<{
    uri: string | null;
    prepareToRecordAsync: () => Promise<void>;
    pause: () => void;
    record: () => void;
    stop: () => Promise<void>;
}>;

type ExpoAudioRecorderConstructor = new (options: unknown) => ExpoAudioRecorderLike;

type ExpoAudioRecorderModule = Readonly<{
    AudioRecorder: ExpoAudioRecorderConstructor;
    /** Expo 55's web module exports this constructor instead of AudioRecorder. */
    AudioRecorderWeb?: ExpoAudioRecorderConstructor;
}>;

type CreateExpoAudioRecorderParams = Readonly<{
    audioModule?: ExpoAudioRecorderModule;
    nativePreset?: unknown;
    platformOS?: string;
    webPreset?: unknown;
}>;

/**
 * Resolve Expo's platform-specific recorder at the package boundary.
 *
 * The native module exposes `AudioRecorder`, while Expo 55's web module exposes
 * `AudioRecorderWeb`; treating them as one runtime export makes browser capture
 * fail before the recorder can acquire its stream. Keep that vendor distinction
 * here so the rest of the voice runtime remains platform-neutral.
 */
export function createExpoAudioRecorder(
    params: CreateExpoAudioRecorderParams = {},
): ExpoAudioRecorderLike {
    // Expo's published TypeScript surface describes the native module even when
    // Metro resolves its web namespace. This narrow boundary cast reflects the
    // two concrete exports shipped by the pinned Expo package.
    const audioModule = params.audioModule
        ?? (AudioModule as unknown as ExpoAudioRecorderModule);
    const platformOS = params.platformOS ?? Platform.OS;
    const isWeb = platformOS === 'web';
    const Recorder = isWeb ? audioModule.AudioRecorderWeb : audioModule.AudioRecorder;
    if (typeof Recorder !== 'function') {
        throw new Error(`expo_audio_recorder_unavailable:${platformOS}`);
    }

    const options = isWeb
        ? (params.webPreset ?? RecordingPresets.HIGH_QUALITY.web)
        : (params.nativePreset ?? RecordingPresets.HIGH_QUALITY);
    return new Recorder(options);
}

import {
  getOptionalHappierAudioStreamNativeModule,
  supportsVoiceFileRecording,
} from './HappierAudioStreamNative';
import type { HappierAudioStreamNativeModule } from './HappierAudioStreamNative.types';

export type VoiceFileRecording = Readonly<{
  start: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  stop: () => Promise<string | null>;
}>;

export function createVoiceFileRecording(
  nativeModule: HappierAudioStreamNativeModule | null = getOptionalHappierAudioStreamNativeModule(),
): VoiceFileRecording | null {
  if (!supportsVoiceFileRecording(nativeModule)) return null;
  let recordingId: string | null = null;

  return Object.freeze({
    start: async () => {
      if (recordingId !== null) throw new Error('voice_file_recording_already_active');
      const started = await nativeModule.startFileRecording({ format: 'm4a' });
      recordingId = started.recordingId;
    },
    setMuted: async (muted) => {
      const activeRecordingId = recordingId;
      if (!activeRecordingId) return;
      await nativeModule.setFileRecordingMuted({ recordingId: activeRecordingId, muted });
    },
    stop: async () => {
      const activeRecordingId = recordingId;
      recordingId = null;
      if (!activeRecordingId) return null;
      const result = await nativeModule.stopFileRecording({ recordingId: activeRecordingId });
      return result.uri;
    },
  });
}

import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceNormalizationDecision,
  ModelPackManifest,
} from '@happier-dev/protocol';

export type VoiceInferenceRuntimeWarmModelInput = Readonly<{
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
}>;

export type VoiceInferenceRuntimeReleaseModelInput = Readonly<{
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
}>;

export type VoiceInferenceRuntimeSynthesizeInput = Readonly<{
  requestId: string;
  text: string;
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  voiceId: string | null;
  speed: number | null;
  output: DaemonVoiceInferenceAudioOutput;
  signal?: AbortSignal | null;
}>;

export type VoiceInferenceRuntimeSynthesizeResult = Readonly<{
  bytes: Uint8Array;
  output: DaemonVoiceInferenceAudioOutput;
  name?: string | null;
}>;

export type VoiceInferenceRuntimeTranscribeInput = Readonly<{
  requestId: string;
  filePath: string;
  inputMimeType: string;
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  language: string | null;
  normalization: DaemonVoiceInferenceNormalizationDecision;
  signal?: AbortSignal | null;
}>;

export type VoiceInferenceRuntimeTranscribeResult = Readonly<{
  text: string;
  language: string | null;
}>;

export type VoiceInferenceRuntime = Readonly<{
  warmModel?: (input: VoiceInferenceRuntimeWarmModelInput) => Promise<void>;
  releaseModel?: (input: VoiceInferenceRuntimeReleaseModelInput) => Promise<void>;
  synthesizeTts: (input: VoiceInferenceRuntimeSynthesizeInput) => Promise<VoiceInferenceRuntimeSynthesizeResult>;
  transcribeAudio: (input: VoiceInferenceRuntimeTranscribeInput) => Promise<VoiceInferenceRuntimeTranscribeResult>;
}>;

export type VoiceInferenceRuntimeEngine = Readonly<
  VoiceInferenceRuntime & {
    decodeAudioInput?: (
      input: VoiceInferenceRuntimeTranscribeInput,
    ) => Promise<Readonly<{ filePath: string; inputMimeType: string }>>;
  }
>;

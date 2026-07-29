import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceNormalizationDecision,
  DaemonVoiceInferenceSttStreamEvent,
  DaemonVoiceInferenceSttStreamPcmFormat,
  ModelPackManifest,
  VoiceModelPackRuntimeV1,
  VoiceModelPackSupportArtifactV1,
} from '@happier-dev/protocol';

type VoiceInferenceRuntimePackContract = Readonly<{
  runtimeDescriptor?: VoiceModelPackRuntimeV1 | null;
  supportArtifacts?: readonly VoiceModelPackSupportArtifactV1[];
}>;

export type VoiceInferenceRuntimeWarmModelInput = Readonly<{
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
}> & VoiceInferenceRuntimePackContract;

export type VoiceInferenceRuntimeReleaseModelInput = Readonly<{
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
}> & VoiceInferenceRuntimePackContract;

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
}> & VoiceInferenceRuntimePackContract;

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
}> & VoiceInferenceRuntimePackContract;

export type VoiceInferenceRuntimeTranscribeResult = Readonly<{
  text: string;
  language: string | null;
}>;

export type VoiceInferenceStreamingTranscriptionSession = Readonly<{
  appendPcm16: (
    input: Readonly<{
      seq: number;
      pcm16Bytes: Uint8Array;
      signal?: AbortSignal | null;
    }>,
  ) => Promise<Readonly<{ events: readonly DaemonVoiceInferenceSttStreamEvent[] }>>;
  finish: (
    input: Readonly<{
      finalSeq: number;
      signal?: AbortSignal | null;
    }>,
  ) => Promise<Readonly<{
    text: string;
    language: string | null;
    events: readonly DaemonVoiceInferenceSttStreamEvent[];
  }>>;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput = Readonly<{
  requestId: string;
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  language: string | null;
  format: DaemonVoiceInferenceSttStreamPcmFormat;
  signal?: AbortSignal | null;
}> & VoiceInferenceRuntimePackContract;

export type VoiceInferenceRuntimePrimeModelInput = Readonly<{
  packId: string;
  packDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
}> & VoiceInferenceRuntimePackContract;

export type VoiceInferenceRuntime = Readonly<{
  warmModel?: (input: VoiceInferenceRuntimeWarmModelInput) => Promise<void>;
  /**
   * Optional priming hook. Runs a tiny dummy synth/recognize once after the model is
   * loaded so the first real utterance does not pay cold-start latency. Idempotent and
   * best-effort: a priming failure must not prevent the model from being reported ready.
   */
  primeModel?: (input: VoiceInferenceRuntimePrimeModelInput) => Promise<void>;
  releaseModel?: (input: VoiceInferenceRuntimeReleaseModelInput) => Promise<void>;
  synthesizeTts: (input: VoiceInferenceRuntimeSynthesizeInput) => Promise<VoiceInferenceRuntimeSynthesizeResult>;
  transcribeAudio: (input: VoiceInferenceRuntimeTranscribeInput) => Promise<VoiceInferenceRuntimeTranscribeResult>;
  createStreamingTranscriptionSession?: (
    input: VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput,
  ) => Promise<VoiceInferenceStreamingTranscriptionSession>;
}>;

export type VoiceInferenceRuntimeEngine = Readonly<
  VoiceInferenceRuntime & {
    decodeAudioInput?: (
      input: VoiceInferenceRuntimeTranscribeInput,
    ) => Promise<Readonly<{ filePath: string; inputMimeType: string }>>;
  }
>;

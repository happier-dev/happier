export type SherpaNativeVoice = {
  id: string;
  title: string;
  sid?: number;
};

export type SherpaNativeInitializeParams = {
  assetsDir: string;
};

export type SherpaNativeListVoicesParams = {
  assetsDir: string;
};

export type SherpaNativeSynthesizeParams = {
  jobId: string;
  assetsDir: string;
  text: string;
  voiceId: string | null;
  sid: number | null;
  speed: number;
  // If provided, native should write the wav file to this path; otherwise it can create its own temp path.
  outWavPath: string | null;
};

export type SherpaNativeSynthesizeResult = {
  wavPath: string;
  sampleRate: number;
};

export type SherpaNativeCancelParams = {
  jobId: string;
};

export type SherpaNativeReleaseParams = {
  // Same assets dir passed to initialize/createStreamingRecognizer; a trailing slash is ignored.
  assetsDir: string;
};

export type SherpaNativeExcludeFromBackupParams = {
  // Absolute filesystem path of an existing directory (iOS iCloud backup; no-op on Android).
  path: string;
};

export type SherpaNativeModule = {
  initialize(params: SherpaNativeInitializeParams): Promise<void>;
  listVoices(params: SherpaNativeListVoicesParams): Promise<SherpaNativeVoice[]>;
  synthesizeToWavFile(params: SherpaNativeSynthesizeParams): Promise<SherpaNativeSynthesizeResult>;
  createStreamingRecognizer(params: {
    jobId: string;
    assetsDir: string;
    sampleRate: number;
    channels: number;
    language: string | null;
  }): Promise<void>;
  pushAudioFrame(params: {
    jobId: string;
    pcm16leBase64: string;
    sampleRate: number;
    channels: number;
  }): Promise<{ text: string; isEndpoint: boolean }>;
  finishStreaming(params: { jobId: string }): Promise<{ text: string }>;
  cancel(params: SherpaNativeCancelParams): Promise<void>;
  /**
   * Drops cached TTS/ASR engines for an assets dir so the next use loads its current files. Resolves after
   * an in-flight synthesis on that engine finishes; running ASR streams keep their engine until they end.
   * Optional: native builds older than this API do not provide it.
   */
  release?(params: SherpaNativeReleaseParams): Promise<void>;
  /** Optional: native builds older than this API do not provide it. */
  excludeFromBackup?(params: SherpaNativeExcludeFromBackupParams): Promise<void>;
};

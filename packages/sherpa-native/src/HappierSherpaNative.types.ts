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

export type SherpaNativeVadFrameResult = {
  speechStarted: boolean;
  speechEnded: boolean;
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
  /**
   * Drop the streaming recognizer cached for `assetsDir` and cancel the jobs
   * decoding against it, so a model pack whose bytes are about to be replaced or
   * removed stops being served from memory.
   *
   * Optional because a JS-only update can run against an older native binary
   * that predates this method; callers must tolerate its absence.
   */
  releaseStreamingAssetsDir?(params: { assetsDir: string }): Promise<{ cancelledJobs: number }>;
  createVadDetector(params: {
    detectorId: string;
    minSpeechMs: number;
    redemptionMs: number;
    sampleRate: number;
  }): Promise<void>;
  pushVadAudioFrame(params: {
    detectorId: string;
    pcm16leBase64: string;
    sampleRate: number;
    channels: number;
  }): Promise<SherpaNativeVadFrameResult>;
  cancelVadDetector(params: {
    detectorId: string;
  }): Promise<void>;
  cancel(params: SherpaNativeCancelParams): Promise<void>;
};

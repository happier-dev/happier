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
};

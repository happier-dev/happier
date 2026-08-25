export type SherpaNativeVoice = {
  id: string;
  title: string;
  sid?: number;
};

export type SherpaNativeInitializeParams = {
  assetsDir: string;
  /**
   * Immutable identifier for one cancellable native initialization request.
   * Optional while an older JS bundle can invoke a newer native module with the
   * predecessor `{ assetsDir }` shape.
   */
  initializationId?: string;
};

export type SherpaNativeCancelInitializationParams = {
  assetsDir: string;
  initializationId: string;
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

/**
 * The outcome of finalizing a streaming-ASR job.
 *
 * `cancelled` and `missing` are not empty transcripts: the job was stopped, or
 * its model pack was invalidated, before the tail decode could produce one.
 * Reporting all three as `{ text: '' }` is what let the controller submit its
 * last revisable interim partial as a final transcript.
 */
export type SherpaNativeStreamingFinalResult =
  | { status: 'finalized'; text: string }
  | { status: 'cancelled' }
  | { status: 'missing' };

export type SherpaNativeVadFrameResult = {
  speechStarted: boolean;
  speechEnded: boolean;
};

export type SherpaNativeModule = {
  initialize(params: SherpaNativeInitializeParams): Promise<void>;
  /**
   * Optional while JS bundles can meet a native binary that predates precise
   * initialization cancellation. Callers must degrade the operation without
   * using pack retirement as a cancellation fallback.
   */
  cancelInitialization?(params: SherpaNativeCancelInitializationParams): Promise<void>;
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
  /**
   * Drain the tail of the job and report which outcome actually happened.
   * Callers must branch on `status`: only `finalized` carries a transcript, and
   * only `finalized` may be submitted. A finalized empty `text` is silence --
   * a successful empty transcript, not a failure.
   */
  finishStreaming(params: { jobId: string }): Promise<SherpaNativeStreamingFinalResult>;
  /**
   * Retire everything the native side caches for `assetsDir` -- the streaming
   * recognizer and the jobs decoding against it, and the offline TTS engine and
   * the synthesis running on it -- so a model pack whose bytes are about to be
   * replaced or removed stops being served from memory.
   *
   * Optional in the type because `requireOptionalNativeModule` resolves whatever
   * the installed binary exposes: a JS bundle running against a native binary
   * that predates this method has no way to retire those engines, which callers
   * must detect rather than silently promote over a live engine.
   */
  releaseAssetsDir?(params: { assetsDir: string }): Promise<{ cancelledJobs: number; releasedEngines: number }>;
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

/**
 * Canonical voice runtime config: defaults and bounds for TTS latency/codec,
 * STT format/upload, warm residency, and per-model concurrency.
 *
 * Owned by protocol so the UI runtime config, UI daemon-inference config, and the
 * CLI daemon worker config read one source of truth. Env overrides stay host-local;
 * hosts apply their own env parsing against these defaults and bounds.
 */

export type VoiceRuntimeBounds = Readonly<{ min: number; max: number }>;

/** TTS output codec/latency/demotion defaults. */
export const VOICE_RUNTIME_TTS_DEFAULTS = {
  defaultCodec: {
    codec: 'wav',
    mimeType: 'audio/wav',
  },
  latencyBudgetMs: 2_000,
  consecutiveSlowCallsBeforeDemotion: 2,
} as const;

/** Bounds for the env-overridable TTS latency budget. */
export const VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS: VoiceRuntimeBounds = { min: 250, max: 60_000 };

/** Bounds for the env-overridable consecutive-slow-call demotion threshold. */
export const VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS: VoiceRuntimeBounds = { min: 1, max: 10 };

/** Warm-residency and concurrency defaults. */
export const VOICE_RUNTIME_WARM_DEFAULTS = {
  warmIdleEvictMs: 5 * 60 * 1000,
  warmOnVoiceHomeAttach: true,
  perModelConcurrency: 1,
} as const;

/** Bounds for the env-overridable warm idle residency. */
export const VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS: VoiceRuntimeBounds = { min: 1_000, max: 60 * 60 * 1000 };

/** Bounds for the env-overridable per-model concurrency. */
export const VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS: VoiceRuntimeBounds = { min: 1, max: 64 };

/** Accepted STT upload mime types. */
export const VOICE_RUNTIME_ACCEPTED_STT_INPUT_FORMATS = [
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/opus',
  'audio/x-caf',
  'audio/3gpp',
] as const;

/** STT upload defaults. */
export const VOICE_RUNTIME_STT_DEFAULTS = {
  maxUploadBytes: 25 * 1024 * 1024,
  acceptedInputFormats: VOICE_RUNTIME_ACCEPTED_STT_INPUT_FORMATS,
} as const;

/** Bounds for the env-overridable STT max upload size. */
export const VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS: VoiceRuntimeBounds = { min: 1, max: 1024 * 1024 * 1024 };

/**
 * Canonical PCM audio format every STT engine consumes. Both the daemon decode
 * chokepoint (ffmpeg) and the packaged sherpa runtime, as well as the on-device
 * streaming sherpa capture path, must produce/resample to this exact format so
 * the audio path stays consistent end to end. This is the single source of truth;
 * centralizing it here prevents the sample-rate/channel/bit-depth from drifting
 * per call site. Not daemon-specific — see the daemon alias below.
 */
export const VOICE_RUNTIME_STT_PCM_FORMAT = {
  sampleRateHz: 16_000,
  channelCount: 1,
  bitsPerSample: 16,
  ffmpegCodec: 'pcm_s16le',
} as const;
export type VoiceRuntimeSttPcmFormat = typeof VOICE_RUNTIME_STT_PCM_FORMAT;

/**
 * Daemon-facing alias of {@link VOICE_RUNTIME_STT_PCM_FORMAT}, retained for the
 * existing daemon consumers (ffmpeg decode + packaged sherpa runtime). Same value
 * by identity — do not redefine; update the canonical const above.
 */
export const VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT = VOICE_RUNTIME_STT_PCM_FORMAT;
export type VoiceRuntimeDaemonSttPcmFormat = typeof VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT;

/**
 * Resident-model memory budget defaults. `maxResidentBytes === 0` means the budget
 * is disabled (no LRU eviction by memory). Hosts apply their own env override against
 * these defaults and bounds; the daemon evicts the least-recently-used loaded model
 * when the resident footprint exceeds the budget.
 */
export const VOICE_RUNTIME_MEMORY_BUDGET_DEFAULTS = {
  maxResidentBytes: 0,
} as const;

/** Bounds for the env-overridable resident-model memory budget (bytes). */
export const VOICE_RUNTIME_MEMORY_BUDGET_BYTES_BOUNDS: VoiceRuntimeBounds = {
  min: 16 * 1024 * 1024,
  max: 256 * 1024 * 1024 * 1024,
};

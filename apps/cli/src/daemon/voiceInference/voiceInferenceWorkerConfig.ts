export const DEFAULT_VOICE_INFERENCE_WORKER_CONFIG = {
    warmIdleEvictMs: 5 * 60 * 1000,
    warmOnVoiceHomeAttach: true,
    perModelConcurrency: 1,
    tts: {
        defaultCodec: {
            codec: 'wav',
            mimeType: 'audio/wav',
        },
        latencyBudgetMs: 2_000,
        consecutiveSlowCallsBeforeDemotion: 2,
    },
    stt: {
        maxUploadBytes: 25 * 1024 * 1024,
        acceptedInputFormats: [
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
        ],
    },
} as const;

const MIN_VOICE_INFERENCE_IDLE_RESIDENCY_MS = 1_000;
const MAX_VOICE_INFERENCE_IDLE_RESIDENCY_MS = 60 * 60 * 1000;
const MIN_VOICE_INFERENCE_PER_MODEL_CONCURRENCY = 1;
const MAX_VOICE_INFERENCE_PER_MODEL_CONCURRENCY = 64;
const MIN_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = 1;
const MAX_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function parseBoundedInt(
    input: string | undefined,
    fallback: number,
    bounds: Readonly<{ min: number; max: number }>,
): number {
    const parsed = Number.parseInt(String(input ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed < bounds.min) {
        return fallback;
    }
    return Math.min(parsed, bounds.max);
}

export function resolveVoiceInferenceIdleResidencyMs(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_IDLE_RESIDENCY_MS,
        DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.warmIdleEvictMs,
        {
            min: MIN_VOICE_INFERENCE_IDLE_RESIDENCY_MS,
            max: MAX_VOICE_INFERENCE_IDLE_RESIDENCY_MS,
        },
    );
}

export function resolveVoiceInferencePerModelConcurrency(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_PER_MODEL_CONCURRENCY,
        DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.perModelConcurrency,
        {
            min: MIN_VOICE_INFERENCE_PER_MODEL_CONCURRENCY,
            max: MAX_VOICE_INFERENCE_PER_MODEL_CONCURRENCY,
        },
    );
}

export function resolveVoiceInferenceSttMaxUploadBytes(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES,
        DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.stt.maxUploadBytes,
        {
            min: MIN_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES,
            max: MAX_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES,
        },
    );
}

export function readVoiceInferenceRuntimeModuleOverride(): string | null {
    const override = String(process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE ?? '').trim();
    return override.length > 0 ? override : null;
}

export function resolveVoiceInferenceAcceptedInputMimeTypes(): readonly string[] {
    return DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.stt.acceptedInputFormats;
}

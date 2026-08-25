import {
    VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS,
    VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_DEFAULTS,
    VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS,
    VOICE_RUNTIME_STT_DEFAULTS,
    VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS,
    VOICE_RUNTIME_TTS_DEFAULTS,
    VOICE_RUNTIME_WARM_DEFAULTS,
    VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS,
} from '@happier-dev/protocol';

export const DEFAULT_VOICE_INFERENCE_WORKER_CONFIG = {
    warmIdleEvictMs: VOICE_RUNTIME_WARM_DEFAULTS.warmIdleEvictMs,
    warmOnVoiceHomeAttach: VOICE_RUNTIME_WARM_DEFAULTS.warmOnVoiceHomeAttach,
    perModelConcurrency: VOICE_RUNTIME_WARM_DEFAULTS.perModelConcurrency,
    tts: {
        defaultCodec: {
            codec: VOICE_RUNTIME_TTS_DEFAULTS.defaultCodec.codec,
            mimeType: VOICE_RUNTIME_TTS_DEFAULTS.defaultCodec.mimeType,
        },
        latencyBudgetMs: VOICE_RUNTIME_TTS_DEFAULTS.latencyBudgetMs,
        consecutiveSlowCallsBeforeDemotion: VOICE_RUNTIME_TTS_DEFAULTS.consecutiveSlowCallsBeforeDemotion,
    },
    stt: {
        maxUploadBytes: VOICE_RUNTIME_STT_DEFAULTS.maxUploadBytes,
        acceptedInputFormats: VOICE_RUNTIME_STT_DEFAULTS.acceptedInputFormats,
    },
} as const;

/**
 * IPC safety defaults for the FORKED voice-inference worker (Lane L7.T7 hardening).
 *
 * These are daemon-local operational facts: the request deadline retires a child that cannot
 * settle an admitted request, while the frame ceiling bounds hostile or corrupt IPC payloads.
 * Idle channels have no product-required work and need no second liveness protocol.
 */
export const VOICE_INFERENCE_WORKER_IPC_DEFAULTS = {
    requestTimeoutMs: 30_000,
    maxFrameBytes: 8 * 1024 * 1024,
} as const;

export const VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS = { min: 1_000, max: 600_000 } as const;
export const VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS = {
    min: 256 * 1024,
    max: 64 * 1024 * 1024,
} as const;

const MIN_VOICE_INFERENCE_IDLE_RESIDENCY_MS = VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS.min;
const MAX_VOICE_INFERENCE_IDLE_RESIDENCY_MS = VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS.max;
const MIN_VOICE_INFERENCE_PER_MODEL_CONCURRENCY = VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS.min;
const MAX_VOICE_INFERENCE_PER_MODEL_CONCURRENCY = VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS.max;
const MIN_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS.min;
const MAX_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS.max;

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

/**
 * Declared loaded-artifact byte budget. `0` disables the LRU eviction budget. Below-min
 * overrides fall back to disabled; over-max overrides clamp to the ceiling. This bounds
 * manifest-declared model-pack bytes, not process memory.
 */
export function resolveVoiceInferenceMaxLoadedArtifactBytes(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_MAX_LOADED_ARTIFACT_BYTES,
        VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_DEFAULTS.maxLoadedArtifactBytes,
        {
            min: VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.min,
            max: VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.max,
        },
    );
}

/**
 * Per-request deadline (ms) for a forked-worker IPC request. On expiry the client rejects
 * that request with `runtime_timeout` and marks the worker unhealthy so the supervisor
 * respawns it. Streaming requests reset the deadline on each chunk of activity.
 */
export function resolveVoiceInferenceWorkerRequestTimeoutMs(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS,
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.requestTimeoutMs,
        VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS,
    );
}

/** Per-IPC-frame byte ceiling for the forked worker (M2 memory bound). */
export function resolveVoiceInferenceWorkerMaxFrameBytes(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES,
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.maxFrameBytes,
        VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS,
    );
}

export function readVoiceInferenceRuntimeModuleOverride(): string | null {
    const override = String(process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE ?? '').trim();
    return override.length > 0 ? override : null;
}

/**
 * Process-isolation mode for the daemon-local voice inference engine.
 *
 * - `forked` (default): the engine runs in a SEPARATE supervised child process behind the
 *   same `VoiceInferenceRuntime` interface, so a native crash/hang cannot take down the
 *   daemon. Supervision (crash containment, restart, request-deadline retirement) is only
 *   actually in force on this path, so it is what an unconfigured install gets.
 * - `in_process`: the native sherpa engine is loaded in the daemon process. This is a
 *   diagnostic/measurement escape hatch and must be requested EXPLICITLY; it has no crash
 *   boundary.
 *
 * This is the single, centralized selection knob — callers must never branch on
 * in-process vs forked anywhere else. Unrecognized values fall back to the supervised
 * `forked` path (fail-safe): a typo must never silently drop the crash boundary.
 */
export type VoiceInferenceRuntimeIsolationMode = 'in_process' | 'forked';

export function resolveVoiceInferenceRuntimeIsolationMode(): VoiceInferenceRuntimeIsolationMode {
    const raw = String(process.env.HAPPIER_VOICE_INFERENCE_ISOLATION ?? '').trim().toLowerCase();
    return raw === 'in_process' ? 'in_process' : 'forked';
}

export function resolveVoiceInferenceAcceptedInputMimeTypes(): readonly string[] {
    return DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.stt.acceptedInputFormats;
}

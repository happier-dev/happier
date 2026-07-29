import {
    VOICE_RUNTIME_MEMORY_BUDGET_BYTES_BOUNDS,
    VOICE_RUNTIME_MEMORY_BUDGET_DEFAULTS,
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
 * Hang-resilience defaults for the FORKED voice-inference worker (Lane L7.T7 hardening).
 *
 * These knobs are daemon-IPC-operational facts (they describe how the supervised child's
 * liveness is policed over the local IPC channel), so they live with the CLI daemon config
 * owner rather than the cross-host protocol voice runtime config.
 *
 * - `requestTimeoutMs`: per-request deadline. A wedged-but-alive child must not hang the
 *   caller forever. Streaming requests reset this deadline on each chunk (activity-based
 *   liveness), so a long legitimate synthesis is never killed while it is making progress.
 * - `pingIntervalMs`: heartbeat cadence. The daemon periodically pings the idle channel.
 * - `missedPingThreshold`: consecutive unanswered pings before the child is declared hung
 *   and force-killed (which triggers the existing supervised restart path).
 * - `maxFrameBytes`: per-IPC-frame ceiling (M2). Lowered far below the historical 64 MiB so
 *   a single base64-inflated TTS frame cannot balloon daemon memory; large audio prefers the
 *   chunked-TTS `partial` path instead.
 */
export const VOICE_INFERENCE_WORKER_HANG_DEFAULTS = {
    requestTimeoutMs: 30_000,
    pingIntervalMs: 5_000,
    missedPingThreshold: 3,
    maxFrameBytes: 8 * 1024 * 1024,
} as const;

export const VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS = { min: 1_000, max: 600_000 } as const;
export const VOICE_INFERENCE_WORKER_PING_INTERVAL_MS_BOUNDS = { min: 500, max: 120_000 } as const;
export const VOICE_INFERENCE_WORKER_MISSED_PING_THRESHOLD_BOUNDS = { min: 1, max: 20 } as const;
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
 * Resident-model memory budget in bytes. `0` disables the budget (no memory-driven LRU
 * eviction). Below-min overrides fall back to disabled; over-max overrides clamp to the
 * ceiling. Centralized here so the budget knob has a single owner.
 */
export function resolveVoiceInferenceMaxResidentBytes(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_MAX_RESIDENT_BYTES,
        VOICE_RUNTIME_MEMORY_BUDGET_DEFAULTS.maxResidentBytes,
        {
            min: VOICE_RUNTIME_MEMORY_BUDGET_BYTES_BOUNDS.min,
            max: VOICE_RUNTIME_MEMORY_BUDGET_BYTES_BOUNDS.max,
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
        VOICE_INFERENCE_WORKER_HANG_DEFAULTS.requestTimeoutMs,
        VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS,
    );
}

/** Heartbeat ping cadence (ms) for the forked-worker liveness watchdog. */
export function resolveVoiceInferenceWorkerPingIntervalMs(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_WORKER_PING_INTERVAL_MS,
        VOICE_INFERENCE_WORKER_HANG_DEFAULTS.pingIntervalMs,
        VOICE_INFERENCE_WORKER_PING_INTERVAL_MS_BOUNDS,
    );
}

/** Consecutive unanswered pings before the forked worker is declared hung and force-killed. */
export function resolveVoiceInferenceWorkerMissedPingThreshold(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_WORKER_MISSED_PING_THRESHOLD,
        VOICE_INFERENCE_WORKER_HANG_DEFAULTS.missedPingThreshold,
        VOICE_INFERENCE_WORKER_MISSED_PING_THRESHOLD_BOUNDS,
    );
}

/** Per-IPC-frame byte ceiling for the forked worker (M2 memory bound). */
export function resolveVoiceInferenceWorkerMaxFrameBytes(): number {
    return parseBoundedInt(
        process.env.HAPPIER_VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES,
        VOICE_INFERENCE_WORKER_HANG_DEFAULTS.maxFrameBytes,
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
 * - `in_process` (default): the native sherpa engine is loaded in the daemon process.
 * - `forked`: the engine runs in a SEPARATE supervised child process behind the same
 *   `VoiceInferenceRuntime` interface, so a native crash/hang cannot take down the daemon.
 *
 * This is the single, centralized selection knob — callers must never branch on
 * in-process vs forked anywhere else. The in-process path stays the default so existing
 * behavior is unchanged unless an operator opts in.
 */
export type VoiceInferenceRuntimeIsolationMode = 'in_process' | 'forked';

export function resolveVoiceInferenceRuntimeIsolationMode(): VoiceInferenceRuntimeIsolationMode {
    const raw = String(process.env.HAPPIER_VOICE_INFERENCE_ISOLATION ?? '').trim().toLowerCase();
    return raw === 'forked' || raw === 'worker' || raw === 'process'
        ? 'forked'
        : 'in_process';
}

export function resolveVoiceInferenceAcceptedInputMimeTypes(): readonly string[] {
    return DEFAULT_VOICE_INFERENCE_WORKER_CONFIG.stt.acceptedInputFormats;
}

type CodexAppServerTimeoutEnv = Readonly<Record<string, string | undefined>>;

export const CODEX_APP_SERVER_TIMEOUT_ENV_KEYS = {
    rpc: 'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    startup: 'HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
    resumeRecovery: 'HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS',
} as const;

const STARTUP_RPC_METHODS = new Set(['initialize']);
const LONG_RUNNING_RPC_METHODS = new Set([
    // Starting a thread is side-effecting admission. A timeout cannot establish whether Codex
    // accepted it, and loaded starts can legitimately exceed the ordinary startup RPC budget.
    'thread/start',
    'thread/resume',
    'thread/fork',
    'conversation/fork',
    // A timeout cannot establish whether Codex accepted this side effect. Keep the
    // request lifecycle-owned so slow admission never becomes ambiguous delivery.
    'turn/start',
    'turn/steer',
]);
const REALTIME_START_RPC_METHOD = 'thread/realtime/start';

// A retained Codex 0.146 provider-boundary run needed 17.118s to produce the
// started/SDP pair. Keep the same bounded 45s budget used by that live probe.
const DEFAULT_REALTIME_START_TIMEOUT_MS = 45_000;
// Codex can spend over 30 seconds replaying state during initialization.
// Keep ordinary startup bounded while leaving enough room for cold starts.
const DEFAULT_STARTUP_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const MAX_RPC_TIMEOUT_MS = 10 * 60_000;

function clampRpcTimeoutMs(rawValue: unknown, fallbackMs: number, maxMs: number): number {
    const raw = Number.parseInt(String(rawValue ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallbackMs;
    return Math.max(250, Math.min(maxMs, configured));
}

export function readCodexAppServerRpcTimeoutMs(env?: CodexAppServerTimeoutEnv): number {
    return clampRpcTimeoutMs(
        env?.[CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.rpc],
        DEFAULT_RPC_TIMEOUT_MS,
        MAX_RPC_TIMEOUT_MS,
    );
}

export function readCodexAppServerStartupRpcTimeoutMs(
    env?: CodexAppServerTimeoutEnv,
    baseTimeoutMs?: number,
): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.[CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.startup],
        DEFAULT_STARTUP_RPC_TIMEOUT_MS,
        120_000,
    );
    return Math.max(base, configured);
}

export function readCodexAppServerResumeRecoveryTimeoutMs(env?: CodexAppServerTimeoutEnv): number {
    const startupTimeoutMs = readCodexAppServerStartupRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.[CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.resumeRecovery],
        120_000,
        10 * 60_000,
    );
    return Math.max(startupTimeoutMs, configured);
}

export function readCodexAppServerRealtimeStartTimeoutMs(
    env?: CodexAppServerTimeoutEnv,
    baseTimeoutMs?: number,
): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    return Math.max(base, DEFAULT_REALTIME_START_TIMEOUT_MS);
}

export function readCodexAppServerRequestTimeoutMs(
    method: string,
    env?: CodexAppServerTimeoutEnv,
): number | null {
    if (LONG_RUNNING_RPC_METHODS.has(method)) {
        return null;
    }
    const baseTimeoutMs = readCodexAppServerRpcTimeoutMs(env);
    if (method === REALTIME_START_RPC_METHOD) {
        return readCodexAppServerRealtimeStartTimeoutMs(env, baseTimeoutMs);
    }
    if (STARTUP_RPC_METHODS.has(method)) {
        return readCodexAppServerStartupRpcTimeoutMs(env, baseTimeoutMs);
    }
    return baseTimeoutMs;
}

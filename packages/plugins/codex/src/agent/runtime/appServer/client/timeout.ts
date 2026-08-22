type CodexAppServerTimeoutEnv = Readonly<Record<string, string | undefined>>;

const STARTUP_RPC_METHODS = new Set(['initialize', 'thread/start', 'thread/resume']);
const FORK_RPC_METHODS = new Set(['thread/fork', 'conversation/fork']);
const REALTIME_START_RPC_METHOD = 'thread/realtime/start';

// A retained Codex 0.146 provider-boundary run needed 17.118s to produce the
// started/SDP pair. Keep the same bounded 45s budget used by that live probe.
const DEFAULT_REALTIME_START_TIMEOUT_MS = 45_000;
// Codex 0.145 can spend just over 30 seconds replaying state during
// initialization. Keep ordinary startup bounded, but above that observed gate.
const DEFAULT_STARTUP_RPC_TIMEOUT_MS = 45_000;

function clampRpcTimeoutMs(rawValue: unknown, fallbackMs: number, maxMs: number): number {
    const raw = Number.parseInt(String(rawValue ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallbackMs;
    return Math.max(250, Math.min(maxMs, configured));
}

export function readCodexAppServerRpcTimeoutMs(env?: CodexAppServerTimeoutEnv): number {
    return clampRpcTimeoutMs(env?.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS, 15_000, 60_000);
}

export function readCodexAppServerStartupRpcTimeoutMs(
    env?: CodexAppServerTimeoutEnv,
    baseTimeoutMs?: number,
): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS,
        DEFAULT_STARTUP_RPC_TIMEOUT_MS,
        120_000,
    );
    return Math.max(base, configured);
}

export function readCodexAppServerResumeRecoveryTimeoutMs(env?: CodexAppServerTimeoutEnv): number {
    const startupTimeoutMs = readCodexAppServerStartupRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS,
        120_000,
        10 * 60_000,
    );
    return Math.max(startupTimeoutMs, configured);
}

export function readCodexAppServerForkRpcTimeoutMs(
    env?: CodexAppServerTimeoutEnv,
    baseTimeoutMs?: number,
): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.HAPPIER_CODEX_APP_SERVER_FORK_RPC_TIMEOUT_MS,
        5 * 60_000,
        5 * 60_000,
    );
    return Math.max(base, configured);
}

export function readCodexAppServerRealtimeStartTimeoutMs(
    env?: CodexAppServerTimeoutEnv,
    baseTimeoutMs?: number,
): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    return Math.max(base, DEFAULT_REALTIME_START_TIMEOUT_MS);
}

export function readCodexAppServerRequestTimeoutMs(method: string, env?: CodexAppServerTimeoutEnv): number {
    const baseTimeoutMs = readCodexAppServerRpcTimeoutMs(env);
    if (FORK_RPC_METHODS.has(method)) {
        return readCodexAppServerForkRpcTimeoutMs(env, baseTimeoutMs);
    }
    if (method === REALTIME_START_RPC_METHOD) {
        return readCodexAppServerRealtimeStartTimeoutMs(env, baseTimeoutMs);
    }
    if (STARTUP_RPC_METHODS.has(method)) {
        return readCodexAppServerStartupRpcTimeoutMs(env, baseTimeoutMs);
    }
    return baseTimeoutMs;
}

const STARTUP_RPC_METHODS = new Set(['initialize', 'thread/start', 'thread/resume']);
const FORK_RPC_METHODS = new Set(['thread/fork', 'conversation/fork']);

function clampRpcTimeoutMs(rawValue: unknown, fallbackMs: number, maxMs: number): number {
    const raw = Number.parseInt(String(rawValue ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallbackMs;
    return Math.max(250, Math.min(maxMs, configured));
}

export function readCodexAppServerRpcTimeoutMs(env?: NodeJS.ProcessEnv): number {
    // 5s is too low for app-server calls like model/mode listing on cold start or under load.
    // Keep it bounded but generous by default.
    return clampRpcTimeoutMs(env?.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS, 15_000, 60_000);
}

export function readCodexAppServerStartupRpcTimeoutMs(env?: NodeJS.ProcessEnv, baseTimeoutMs?: number): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(env?.HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS, 20_000, 120_000);
    return Math.max(base, configured);
}

export function readCodexAppServerResumeRecoveryTimeoutMs(env?: NodeJS.ProcessEnv): number {
    const startupTimeoutMs = readCodexAppServerStartupRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS,
        120_000,
        10 * 60_000,
    );
    return Math.max(startupTimeoutMs, configured);
}

export function readCodexAppServerForkRpcTimeoutMs(env?: NodeJS.ProcessEnv, baseTimeoutMs?: number): number {
    const base = baseTimeoutMs ?? readCodexAppServerRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(
        env?.HAPPIER_CODEX_APP_SERVER_FORK_RPC_TIMEOUT_MS,
        5 * 60_000,
        5 * 60_000,
    );
    return Math.max(base, configured);
}

export function readCodexAppServerRequestTimeoutMs(method: string, env?: NodeJS.ProcessEnv): number {
    const baseTimeoutMs = readCodexAppServerRpcTimeoutMs(env);
    if (STARTUP_RPC_METHODS.has(method)) {
        return readCodexAppServerStartupRpcTimeoutMs(env, baseTimeoutMs);
    }
    if (FORK_RPC_METHODS.has(method)) {
        return readCodexAppServerForkRpcTimeoutMs(env, baseTimeoutMs);
    }
    return baseTimeoutMs;
}

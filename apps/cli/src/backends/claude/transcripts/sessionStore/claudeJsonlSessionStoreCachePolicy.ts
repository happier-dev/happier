const DEFAULT_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS = 5_000;
const DEFAULT_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS = 30_000;
const MIN_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS = 250;
const MIN_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS = 1_000;
const MAX_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS = 60_000;
const MAX_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS = 300_000;

function resolveBoundedIntEnv(params: Readonly<{
    env: NodeJS.ProcessEnv;
    envVar: string;
    defaultValue: number;
    minValue: number;
    maxValue: number;
}>): number {
    const raw = String(params.env[params.envVar] ?? '').trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < params.minValue) {
        return params.defaultValue;
    }
    return Math.min(parsed, params.maxValue);
}

export function resolveClaudeJsonlSessionStoreDetachedGraceMs(env: NodeJS.ProcessEnv = process.env): number {
    return resolveBoundedIntEnv({
        env,
        envVar: 'HAPPIER_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS',
        defaultValue: DEFAULT_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS,
        minValue: MIN_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS,
        maxValue: MAX_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS,
    });
}

export function resolveClaudeJsonlSessionStoreColdIdleMs(env: NodeJS.ProcessEnv = process.env): number {
    return resolveBoundedIntEnv({
        env,
        envVar: 'HAPPIER_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS',
        defaultValue: DEFAULT_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS,
        minValue: MIN_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS,
        maxValue: MAX_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS,
    });
}

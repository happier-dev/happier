import type { DbProvider } from "@/storage/db";

export interface VoiceProviderIdentityBackfillPolicy {
    readonly enabled: boolean;
    readonly batchSize: number;
    readonly timeBudgetMs: number;
    readonly batchDelayMs: number;
    readonly intervalMs: number;
    readonly lockTtlMs: number;
}

export const DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE = 100;
export const DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS = 5_000;
export const DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS = 100;
export const DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS = 60_000;
const LOCK_TTL_GRACE_MS = 5 * 60_000;

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
    const raw = String(env[key] ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${key} must be true or false`);
}

function readInteger(params: Readonly<{
    env: NodeJS.ProcessEnv;
    key: string;
    fallback: number;
    min: number;
    max: number;
}>): number {
    const raw = String(params.env[params.key] ?? "").trim();
    if (!raw) return params.fallback;
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${params.key} must be an integer from ${params.min} to ${params.max}`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
        throw new Error(`${params.key} must be an integer from ${params.min} to ${params.max}`);
    }
    return value;
}

export function readVoiceProviderIdentityBackfillPolicy(
    env: NodeJS.ProcessEnv,
    provider: DbProvider,
): VoiceProviderIdentityBackfillPolicy {
    if (provider === "mysql") {
        return Object.freeze({
            enabled: false,
            batchSize: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE,
            timeBudgetMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
            batchDelayMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS,
            intervalMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS,
            lockTtlMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS + LOCK_TTL_GRACE_MS,
        });
    }
    const batchSize = readInteger({
        env,
        key: "HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE",
        fallback: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE,
        min: 1,
        max: 1_000,
    });
    const timeBudgetMs = readInteger({
        env,
        key: "HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS",
        fallback: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
        min: 1,
        max: 15 * 60_000,
    });
    const batchDelayMs = readInteger({
        env,
        key: "HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS",
        fallback: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS,
        min: 0,
        max: 60_000,
    });
    const intervalMs = readInteger({
        env,
        key: "HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS",
        fallback: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS,
        min: 1_000,
        max: 24 * 60 * 60_000,
    });
    const requestedEnabled = readBoolean(
        env,
        "HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED",
        false,
    );

    return Object.freeze({
        enabled: requestedEnabled,
        batchSize,
        timeBudgetMs,
        batchDelayMs,
        intervalMs,
        lockTtlMs: timeBudgetMs + LOCK_TTL_GRACE_MS,
    });
}

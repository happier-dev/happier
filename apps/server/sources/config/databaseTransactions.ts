import type { DbProvider } from "@/storage/prisma";
import { parseFloatEnv, parseIntEnv } from "./env";

type EnvLike = Record<string, string | undefined>;

export type DatabaseTransactionConfig = Readonly<{
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    retryJitterFactor: number;
    timeoutMs: number;
    maxWaitMs: number;
    totalRetryBudgetMs: number;
}>;

function getDefaultMaxRetries(provider: DbProvider): number {
    if (provider === "sqlite") return 8;
    return 8;
}

function getDefaultRetryBaseDelayMs(provider: DbProvider): number {
    if (provider === "sqlite") return 100;
    return 200;
}

function getDefaultRetryMaxDelayMs(provider: DbProvider): number {
    if (provider === "sqlite") return 1_600;
    return 5_000;
}

function getDefaultRetryJitterFactor(provider: DbProvider): number {
    if (provider === "sqlite") return 0;
    return 0.25;
}

function getDefaultTimeoutMs(provider: DbProvider): number {
    if (provider === "sqlite") return 10_000;
    return 15_000;
}

function getDefaultMaxWaitMs(provider: DbProvider): number {
    if (provider === "sqlite") return 5_000;
    return 10_000;
}

function getDefaultTotalRetryBudgetMs(provider: DbProvider): number {
    // A SQLite attempt can spend maxWaitMs acquiring a connection and then
    // timeoutMs inside the transaction. Keep enough room for one complete
    // retry plus its initial backoff so a timeout is actually recoverable.
    if (provider === "sqlite") return 40_000;
    return 600_000;
}

export function readDatabaseTransactionConfigFromEnv(
    env: EnvLike,
    provider: DbProvider,
): DatabaseTransactionConfig {
    const retryBaseDelayMs = parseIntEnv(
        env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_BASE_DELAY_MS,
        getDefaultRetryBaseDelayMs(provider),
        { min: 0, max: 60_000 },
    );
    const retryMaxDelayMs = parseIntEnv(
        env.HAPPIER_DB_TX_RETRY_MAX_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_MAX_DELAY_MS,
        getDefaultRetryMaxDelayMs(provider),
        { min: retryBaseDelayMs, max: 600_000 },
    );
    const retryJitterFactor = parseFloatEnv(
        env.HAPPIER_DB_TX_RETRY_JITTER_FACTOR ?? env.HAPPY_DB_TX_RETRY_JITTER_FACTOR,
        getDefaultRetryJitterFactor(provider),
        { min: 0, max: 1 },
    );

    return {
        maxRetries: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_RETRIES ?? env.HAPPY_DB_TX_MAX_RETRIES,
            getDefaultMaxRetries(provider),
            { min: 0, max: 100 },
        ),
        retryBaseDelayMs,
        retryMaxDelayMs,
        retryJitterFactor,
        timeoutMs: parseIntEnv(
            env.HAPPIER_DB_TX_TIMEOUT_MS ?? env.HAPPY_DB_TX_TIMEOUT_MS,
            getDefaultTimeoutMs(provider),
            { min: 1_000, max: 600_000 },
        ),
        maxWaitMs: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_WAIT_MS ?? env.HAPPY_DB_TX_MAX_WAIT_MS,
            getDefaultMaxWaitMs(provider),
            { min: 1_000, max: 600_000 },
        ),
        totalRetryBudgetMs: parseIntEnv(
            env.HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS ?? env.HAPPY_DB_TX_TOTAL_RETRY_BUDGET_MS,
            getDefaultTotalRetryBudgetMs(provider),
            { min: 1, max: 600_000 },
        ),
    };
}

export function resolveTransactionRetryDelayMs(params: Readonly<{
    attempt: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    retryJitterFactor: number;
    randomUnit?: number;
}>): number {
    const cappedExponentialDelay =
        params.attempt <= 1
            ? params.retryBaseDelayMs
            : Math.min(params.retryMaxDelayMs, params.retryBaseDelayMs * 2 ** (params.attempt - 1));

    if (params.retryJitterFactor <= 0) {
        return cappedExponentialDelay;
    }

    const randomUnit = Math.min(1, Math.max(0, params.randomUnit ?? Math.random()));
    const lowerBound = Math.max(0, cappedExponentialDelay * (1 - params.retryJitterFactor));
    const upperBound = Math.min(params.retryMaxDelayMs, cappedExponentialDelay * (1 + params.retryJitterFactor));
    return Math.round(lowerBound + (upperBound - lowerBound) * randomUnit);
}

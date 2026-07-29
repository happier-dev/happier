import { describe, expect, it } from "vitest";

import { readDatabaseTransactionConfigFromEnv, resolveTransactionRetryDelayMs } from "./databaseTransactions";

describe("databaseTransactions", () => {
    it("uses stronger postgres retry defaults for transaction conflicts", () => {
        expect(readDatabaseTransactionConfigFromEnv({}, "postgres")).toEqual({
            maxRetries: 8,
            retryBaseDelayMs: 200,
            retryMaxDelayMs: 5_000,
            retryJitterFactor: 0.25,
            timeoutMs: 15_000,
            maxWaitMs: 10_000,
            totalRetryBudgetMs: 600_000,
        });
    });

    it("keeps bounded sqlite defaults with enough budget for one full retry", () => {
        const config = readDatabaseTransactionConfigFromEnv({}, "sqlite");

        expect(config).toEqual({
            maxRetries: 8,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 1_600,
            retryJitterFactor: 0,
            timeoutMs: 10_000,
            maxWaitMs: 5_000,
            totalRetryBudgetMs: 40_000,
        });
        expect(config.totalRetryBudgetMs).toBeGreaterThanOrEqual(
            2 * (config.maxWaitMs + config.timeoutMs) + config.retryBaseDelayMs,
        );
    });

    it("allows environment overrides within safe bounds", () => {
        expect(
            readDatabaseTransactionConfigFromEnv(
                {
                    HAPPIER_DB_TX_MAX_RETRIES: "7",
                    HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "250",
                    HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: "5000",
                    HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0.4",
                    HAPPIER_DB_TX_TIMEOUT_MS: "15000",
                    HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
                    HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "30000",
                },
                "postgres",
            ),
        ).toEqual({
            maxRetries: 7,
            retryBaseDelayMs: 250,
            retryMaxDelayMs: 5_000,
            retryJitterFactor: 0.4,
            timeoutMs: 15_000,
            maxWaitMs: 7_000,
            totalRetryBudgetMs: 30_000,
        });
    });

    it("caps retry delays exponentially", () => {
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 1,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(200);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 2,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(400);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 3,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(800);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 4,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(1_600);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 5,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(3_200);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 6,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(5_000);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 7,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0,
            }),
        ).toBe(5_000);
    });

    it("applies bounded retry jitter when enabled", () => {
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 3,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0.25,
                randomUnit: 0,
            }),
        ).toBe(600);
        expect(
            resolveTransactionRetryDelayMs({
                attempt: 3,
                retryBaseDelayMs: 200,
                retryMaxDelayMs: 5_000,
                retryJitterFactor: 0.25,
                randomUnit: 1,
            }),
        ).toBe(1_000);
    });
});

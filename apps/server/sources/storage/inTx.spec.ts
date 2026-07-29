import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock } from "../app/api/testkit/dbMocks";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});
const recordDatabaseTransactionRetry = vi.fn();

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));
vi.mock("@/app/monitoring/metrics/sessionWriteMetrics", () => ({
    recordDatabaseTransactionRetry: (...args: any[]) => recordDatabaseTransactionRetry(...args),
}));

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        transaction.mockReset();
        transaction.mockImplementation(async (fn: any, _opts?: any) => fn({} as any));
        delayMock.mockClear();
        recordDatabaseTransactionRetry.mockClear();
    });

    it("uses serializable transactions by default", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 123);

        expect(result).toBe(123);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(expect.objectContaining({ isolationLevel: "Serializable" }));
    });

    it("passes configured transaction timeout options without isolationLevel on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TIMEOUT_MS: "12000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: 7000,
                timeout: 12000,
            }),
        );
        expect(transaction.mock.calls[0]![1]).not.toEqual(
            expect.objectContaining({ isolationLevel: expect.anything() }),
        );
    });

    it("allows overriding the isolation level for postgres hot paths", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 321, { isolationLevel: "ReadCommitted" });

        expect(result).toBe(321);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({ isolationLevel: "ReadCommitted" }),
        );
    });

    it("retries P2034 and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 789);

        expect(result).toBe(789);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("postgres");
    });

    it("retries repeated postgres P2034 conflicts until a later attempt succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me 1"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 2"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 3"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 4"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 5"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 6"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 7"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 8"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 1337);

        expect(result).toBe(1337);
        expect(transaction).toHaveBeenCalledTimes(9);
        expect(delayMock).toHaveBeenCalledTimes(8);
        expect(delayMock.mock.calls).toEqual([[200], [400], [800], [1600], [3200], [5000], [5000], [5000]]);
    });

    it.each(["postgres", "mysql"])("retries transaction acquisition P2028 before the callback starts on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction
            .mockRejectedValueOnce(acquisitionError)
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));
        const transactionBody = vi.fn(async () => 790);

        const { inTx } = await import("./inTx");
        await expect(inTx(transactionBody)).resolves.toBe(790);

        expect(transaction).toHaveBeenCalledTimes(2);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("reports exhausted transaction acquisition as typed unavailability with the original cause", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_DB_TX_MAX_RETRIES: "0",
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction.mockRejectedValue(acquisitionError);
        const transactionBody = vi.fn(async () => 791);

        const inTxModule = await import("./inTx");
        const rejection = await inTxModule.inTx(transactionBody).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(inTxModule.TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transactionBody).not.toHaveBeenCalled();
    });

    it("does not classify an acquisition-shaped P2028 thrown after the callback starts as transaction acquisition", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
        });
        const operationError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const transactionBody = vi.fn(async () => {
            throw operationError;
        });

        const { inTx } = await import("./inTx");
        await expect(inTx(transactionBody)).rejects.toBe(operationError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it("retries raw postgres serialization aborts that are not wrapped as P2034", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(new Error("could not serialize access due to read/write dependencies among transactions"))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 4242);

        expect(result).toBe(4242);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("postgres");
    });

    it("retries sqlite P1008 socket timeout and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Socket timeout"), { code: "P1008" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 9001);

        expect(result).toBe(9001);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("retries sqlite P2024 connection pool timeouts and preserves retry metrics", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 9002);

        expect(result).toBe(9002);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("sqlite");
    });

    it("does not start a sqlite retry that would exceed the configured total retry budget", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "1",
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "100",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
        });
        const timeoutError = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        transaction
            .mockRejectedValueOnce(timeoutError)
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const { inTx } = await import("./inTx");

        await expect(inTx(async () => 9003)).rejects.toBe(timeoutError);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
        expect(recordDatabaseTransactionRetry).not.toHaveBeenCalled();
    });
});

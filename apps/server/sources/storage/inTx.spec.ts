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

    it("avoids isolationLevel options on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(1);
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
});

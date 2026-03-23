import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock } from "../app/api/testkit/dbMocks";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        transaction.mockClear();
        delayMock.mockClear();
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

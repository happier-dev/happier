import { afterEach, describe, expect, it, vi } from "vitest";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});

vi.mock("@/storage/db", () => ({
    db: {
        $transaction: transaction,
    },
}));

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));

describe("inTx", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        transaction.mockClear();
        delayMock.mockClear();
    });

    it("uses serializable transactions by default", async () => {
        process.env = { ...originalEnv };
        delete process.env.HAPPY_DB_PROVIDER;
        delete process.env.HAPPIER_DB_PROVIDER;

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 123);

        expect(result).toBe(123);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(expect.objectContaining({ isolationLevel: "Serializable" }));
    });

    it("avoids isolationLevel options on SQLite", async () => {
        process.env = { ...originalEnv, HAPPY_DB_PROVIDER: "sqlite" };

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(1);
    });

    it("retries P2034 and eventually succeeds", async () => {
        process.env = { ...originalEnv };
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
        process.env = { ...originalEnv, HAPPY_DB_PROVIDER: "sqlite" };
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

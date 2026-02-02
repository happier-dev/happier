import { afterEach, describe, expect, it, vi } from "vitest";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));

vi.mock("@/storage/db", () => ({
    db: {
        $transaction: transaction,
    },
}));

vi.mock("@/utils/delay", () => ({ delay: vi.fn(async () => {}) }));

describe("inTx", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        transaction.mockClear();
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
});

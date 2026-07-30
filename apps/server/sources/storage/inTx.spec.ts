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
vi.mock("@/utils/logging/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        vi.restoreAllMocks();
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

    it("passes timeout options without isolationLevel on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: expect.any(Number),
                timeout: expect.any(Number),
            }),
        );
        expect(transaction.mock.calls[0]![1]).not.toEqual(expect.objectContaining({ isolationLevel: expect.anything() }));
    });

    it("uses configured SQLite transaction timeout options", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TIMEOUT_MS: "12000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 654);

        expect(result).toBe(654);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: 7000,
                timeout: 12000,
            }),
        );
    });

    it("logs afterTx callback failures and still runs remaining callbacks", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const failure = new Error("fan-out failed");
        const laterCallback = vi.fn();
        const { inTx, afterTx } = await import("./inTx");
        const { warn } = await import("@/utils/logging/log");

        const result = await inTx(async (tx) => {
            afterTx(tx, () => {
                throw failure;
            });
            afterTx(tx, laterCallback);
            return 321;
        });

        expect(result).toBe(321);
        expect(laterCallback).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ module: "inTx", error: failure }),
            expect.any(String),
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

    it("retries sqlite P2024 transaction pool timeouts and eventually succeeds", async () => {
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
    });

    it("does not schedule a sqlite retry that would exceed the configured transaction budget", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_MAX_RETRIES: "8",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "15000",
        });
        const timeoutError = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        transaction.mockRejectedValue(timeoutError);
        vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(20_000);

        const { inTx } = await import("./inTx");
        await expect(inTx(async () => 9003)).rejects.toBe(timeoutError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });
});

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
        vi.restoreAllMocks();
        transaction.mockReset();
        transaction.mockImplementation(async (fn: any, _opts?: any) => fn({} as any));
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

    it("gives up on P2034 after three retries by default", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_MAX_RETRIES: undefined,
            HAPPY_DB_TX_MAX_RETRIES: undefined,
        });
        const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
        transaction.mockRejectedValue(conflict);

        const { inTx } = await import("./inTx");
        await expect(inTx(async () => 1)).rejects.toBe(conflict);

        expect(transaction).toHaveBeenCalledTimes(4);
        expect(delayMock).toHaveBeenCalledTimes(3);
    });

    it("reads the P2034 retry limit from HAPPIER_DB_TX_MAX_RETRIES on postgres", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_MAX_RETRIES: "6",
        });
        const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
        transaction.mockRejectedValue(conflict);

        const { inTx } = await import("./inTx");
        await expect(inTx(async () => 1)).rejects.toBe(conflict);

        expect(transaction).toHaveBeenCalledTimes(7);
        expect(delayMock).toHaveBeenCalledTimes(6);
    });

    it("backs off exponentially with jitter between P2034 retries on postgres", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_MAX_RETRIES: "6",
        });
        const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
        transaction.mockRejectedValue(conflict);
        const random = vi.spyOn(Math, "random");

        const { inTx } = await import("./inTx");
        random.mockReturnValue(0.5); // jitter factor 1.0
        await expect(inTx(async () => 1)).rejects.toBe(conflict);
        expect((delayMock.mock.calls as unknown as number[][]).map(([ms]) => ms)).toEqual([100, 200, 400, 800, 1600, 1600]);

        delayMock.mockClear();
        random.mockReturnValue(0); // jitter factor 0.5
        await expect(inTx(async () => 1)).rejects.toBe(conflict);
        expect((delayMock.mock.calls as unknown as number[][]).map(([ms]) => ms)).toEqual([50, 100, 200, 400, 800, 800]);
    });

    it.each(["postgres", "mysql"])("retries an acquisition-shaped P2028 before the transaction callback starts on %s", async (provider) => {
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
        const result = await inTx(transactionBody);

        expect(result).toBe(790);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each(["postgres", "mysql"])("reports acquisition unavailability with the original P2028 after retries are exhausted on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction.mockRejectedValue(acquisitionError);
        const transactionBody = vi.fn(async () => 791);

        const { inTx, TransactionAcquisitionUnavailableError } = await import("./inTx");
        const rejection = await inTx(transactionBody).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transaction).toHaveBeenCalledTimes(4);
        expect(transactionBody).not.toHaveBeenCalled();
        expect(delayMock).toHaveBeenCalledTimes(3);
    });

    it.each(["postgres", "sqlite", "mysql"])("does not retry an acquisition-shaped P2028 after the transaction callback starts on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
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

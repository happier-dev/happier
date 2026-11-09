import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock } from "../app/api/testkit/dbMocks";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});
const loggingMocks = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));
vi.mock("@/utils/logging/log", () => loggingMocks);

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        vi.restoreAllMocks();
        transaction.mockClear();
        delayMock.mockClear();
        loggingMocks.debug.mockClear();
        loggingMocks.warn.mockClear();
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

    it("attributes a labeled successful transaction across acquisition, body, and settlement without a warning", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        vi.spyOn(Date, "now")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(5)
            .mockReturnValueOnce(5)
            .mockReturnValueOnce(7_005)
            .mockReturnValueOnce(12_005);

        const { inTx, IN_TX_OPERATION_LABELS } = await import("./inTx");
        await expect(inTx(async () => 654, {
            diagnostics: { operation: IN_TX_OPERATION_LABELS.sessionOrganizationPin },
        })).resolves.toBe(654);

        expect(loggingMocks.warn).not.toHaveBeenCalled();
        expect(loggingMocks.debug.mock.calls.map(([fields]) => fields)).toEqual([
            expect.objectContaining({ operation: "session.organization.pin", phase: "acquisition", state: "started" }),
            expect.objectContaining({ operation: "session.organization.pin", phase: "body", state: "started" }),
            expect.objectContaining({ operation: "session.organization.pin", phase: "settlement", state: "started" }),
            expect.objectContaining({
                operation: "session.organization.pin",
                phase: "settled",
                outcome: "succeeded",
                acquisitionMs: 5,
                bodyMs: 7_000,
                settlementMs: 5_000,
            }),
        ]);
    });

    it("attributes a pin acquisition failure to the active labeled transaction holder", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_MAX_RETRIES: "0",
        });
        const acquisitionError = Object.assign(
            new Error("secret SQL and request payload"),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        let holderEntered!: () => void;
        const holderEntry = new Promise<void>((resolve) => { holderEntered = resolve; });
        transaction
            .mockImplementationOnce(async (fn: any) => await fn({} as any))
            .mockRejectedValueOnce(acquisitionError);

        const { inTx, IN_TX_OPERATION_LABELS } = await import("./inTx");
        const holder = inTx(async () => {
            holderEntered();
            await holderRelease;
            return "written";
        }, {
            diagnostics: { operation: IN_TX_OPERATION_LABELS.sessionMessageWrite },
        });
        await holderEntry;

        await expect(inTx(async () => "pin", {
            diagnostics: { operation: IN_TX_OPERATION_LABELS.sessionOrganizationPin },
        })).rejects.toMatchObject({ code: "P2028" });

        expect(loggingMocks.warn).toHaveBeenCalledWith(expect.objectContaining({
            operation: "session.organization.pin",
            phase: "acquisition",
            holderAttribution: "labeled-active-operations",
            activeTransactions: [expect.objectContaining({
                operation: "session.message.write",
                phase: "body",
                activeMs: expect.any(Number),
            })],
        }), "Database transaction attribution warning");
        expect(JSON.stringify(loggingMocks.warn.mock.calls)).not.toContain("secret SQL and request payload");

        releaseHolder();
        await expect(holder).resolves.toBe("written");
    });

    it("shares active transaction attribution with a direct batch transaction wrapper", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_MAX_RETRIES: "0",
        });
        const acquisitionError = Object.assign(new Error("hidden values"), {
            code: "P2028",
            meta: { error: "Unable to start a transaction in the given time." },
        });
        transaction.mockRejectedValueOnce(acquisitionError);
        let releaseBatch!: () => void;
        const batchRelease = new Promise<void>((resolve) => { releaseBatch = resolve; });

        const {
            inTx,
            IN_TX_OPERATION_LABELS,
            runWithTransactionAttribution,
        } = await import("./inTx");
        const batch = runWithTransactionAttribution(
            IN_TX_OPERATION_LABELS.machinePresenceBatch,
            async () => await batchRelease,
        );

        await expect(inTx(async () => "pin", {
            diagnostics: { operation: IN_TX_OPERATION_LABELS.sessionOrganizationPin },
        })).rejects.toMatchObject({ code: "P2028" });
        expect(loggingMocks.warn).toHaveBeenCalledWith(expect.objectContaining({
            holderAttribution: "labeled-active-operations",
            activeTransactions: [expect.objectContaining({
                operation: "machine.presence.batch",
                phase: "acquisition-or-transaction",
                activeMs: expect.any(Number),
            })],
        }), "Database transaction attribution warning");

        releaseBatch();
        await expect(batch).resolves.toBeUndefined();
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
        const rejection = await inTx(transactionBody, {
            diagnostics: { operation: "session.organization.pin" },
        }).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transaction).toHaveBeenCalledTimes(4);
        expect(transactionBody).not.toHaveBeenCalled();
        expect(delayMock).toHaveBeenCalledTimes(3);
        expect(loggingMocks.warn).toHaveBeenCalledTimes(1);
        expect(loggingMocks.warn).toHaveBeenCalledWith(expect.objectContaining({
            event: "database-transaction-attribution",
            operation: "session.organization.pin",
            phase: "acquisition",
            outcome: "failed",
            attemptCount: 4,
            holderAttribution: "unattributed",
            activeTransactions: [],
        }), "Database transaction attribution warning");
        expect(JSON.stringify(loggingMocks.warn.mock.calls)).not.toContain("Unable to start");
    });

    it("distinguishes labeled callback failure from transaction settlement failure without logging error payloads", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        const sensitiveError = new Error("secret request payload");
        const { inTx } = await import("./inTx");

        transaction.mockImplementationOnce(async (fn: any) => await fn({} as any));
        await expect(inTx(async () => { throw sensitiveError; }, {
            diagnostics: { operation: "session.organization.pin" },
        })).rejects.toBe(sensitiveError);
        expect(loggingMocks.warn).toHaveBeenLastCalledWith(expect.objectContaining({
            operation: "session.organization.pin",
            phase: "body",
            outcome: "failed",
        }), "Database transaction attribution warning");

        loggingMocks.warn.mockClear();
        transaction.mockImplementationOnce(async (fn: any) => {
            await fn({} as any);
            throw sensitiveError;
        });
        await expect(inTx(async () => 1, {
            diagnostics: { operation: "session.organization.pin" },
        })).rejects.toBe(sensitiveError);
        expect(loggingMocks.warn).toHaveBeenLastCalledWith(expect.objectContaining({
            operation: "session.organization.pin",
            phase: "settlement",
            outcome: "failed",
        }), "Database transaction attribution warning");
        expect(JSON.stringify(loggingMocks.warn.mock.calls)).not.toContain("secret request payload");
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

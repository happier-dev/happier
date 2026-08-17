import { describe, expect, it, vi } from "vitest";

import {
    formatSessionSystemRecordBackfillFailure,
    runSessionSystemRecordBackfillCommand,
} from "./sessionSystemRecordBackfill";
import type { SessionSystemRecordBackfillExecutionDependencies } from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import type { PrismaClientType } from "../sources/storage/db";

type TestMaintenanceClient = Pick<
    PrismaClientType,
    "$connect" | "$disconnect" | "$transaction" | "$queryRawUnsafe"
>;

function createTestMaintenanceClient(params: Readonly<{ connectError?: Error }> = {}): Readonly<{
    connect: ReturnType<typeof vi.fn<PrismaClientType["$connect"]>>;
    disconnect: ReturnType<typeof vi.fn<PrismaClientType["$disconnect"]>>;
    createClient: NonNullable<SessionSystemRecordBackfillExecutionDependencies["createClient"]>;
}> {
    const connect = vi.fn<PrismaClientType["$connect"]>(async () => {
        if (params.connectError) throw params.connectError;
    });
    const disconnect = vi.fn<PrismaClientType["$disconnect"]>(async () => {});
    const client = {
        $connect: connect,
        $disconnect: disconnect,
        // The command-level test stubs the database execution boundary; these
        // methods remain typed so it cannot accidentally use internal logic.
        $transaction: vi.fn<PrismaClientType["$transaction"]>(),
        $queryRawUnsafe: vi.fn<PrismaClientType["$queryRawUnsafe"]>(),
    } satisfies TestMaintenanceClient;
    return {
        connect,
        disconnect,
        createClient: async () => client,
    };
}

describe("formatSessionSystemRecordBackfillFailure", () => {
    it("preserves the bounded writer-barrier instruction but hides unrelated failure details", () => {
        expect(formatSessionSystemRecordBackfillFailure(new Error(
            "[session-system-records] exclude every predecessor writer",
        ))).toMatchObject({
            reason: "operator_setup_or_runtime_failed",
            detail: "[session-system-records] exclude every predecessor writer",
        });
        expect(formatSessionSystemRecordBackfillFailure(new Error(
            "postgres://secret@example.test",
        ))).not.toHaveProperty("detail");
    });
});

describe("runSessionSystemRecordBackfillCommand", () => {
    it("runs the final current-version audit without an obsolete predecessor-writer admission switch", async () => {
        const maintenance = createTestMaintenanceClient();
        const runOperator = vi.fn(async () => ({
            outcome: "drained" as const,
            pages: 1,
            processed: 0,
            updated: 0,
            audit: { pages: 1, processed: 0, nullRows: 0, mismatchedRows: 0 },
        }));

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: { HAPPIER_DB_PROVIDER: "postgres" },
            createClient: maintenance.createClient,
            runOperator,
        })).resolves.toBe(0);

        expect(maintenance.connect).toHaveBeenCalledTimes(1);
        expect(maintenance.disconnect).toHaveBeenCalledTimes(1);
        expect(runOperator).toHaveBeenCalledTimes(1);
    });

    it("runs the final canonical audit without requiring a rollback-only approval environment variable", async () => {
        const maintenance = createTestMaintenanceClient();
        const writeOutput = vi.fn();
        const runOperator = vi.fn(async () => ({
            outcome: "drained" as const,
            pages: 1,
            processed: 0,
            updated: 0,
            audit: { pages: 1, processed: 4, nullRows: 0, mismatchedRows: 0 },
        }));

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
            },
            createClient: maintenance.createClient,
            runOperator,
            writeOutput,
        })).resolves.toBe(0);

        expect(runOperator).toHaveBeenCalledTimes(1);
        expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('"mode":"final-contract"'));
    });

    it("does not admit CONTRACT when the final audit retains a null or mismatched row", async () => {
        const maintenance = createTestMaintenanceClient();
        const writeOutput = vi.fn();

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
            },
            createClient: maintenance.createClient,
            runOperator: vi.fn(async () => ({
                outcome: "drained" as const,
                pages: 1,
                processed: 0,
                updated: 0,
                audit: { pages: 1, processed: 1, nullRows: 1, mismatchedRows: 0 },
            })),
            writeOutput,
        })).resolves.toBe(1);

        expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('"mode":"final-contract"'));
    });

    it("returns a non-zero exit code when the bounded run has not drained", async () => {
        const maintenance = createTestMaintenanceClient();
        const writeOutput = vi.fn();

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: [],
            env: { HAPPIER_DB_PROVIDER: "postgres" },
            createClient: maintenance.createClient,
            runOperator: vi.fn(async () => ({
                outcome: "time_budget" as const,
                pages: 1,
                processed: 100,
                updated: 100,
                audit: { pages: 0, processed: 0, nullRows: 0, mismatchedRows: 0 },
            })),
            writeOutput,
        })).resolves.toBe(1);

        expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('"outcome":"time_budget"'));
    });

    it("returns a non-zero exit code when the final address audit fails", async () => {
        const maintenance = createTestMaintenanceClient();
        const writeOutput = vi.fn();

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: [],
            env: { HAPPIER_DB_PROVIDER: "postgres" },
            createClient: maintenance.createClient,
            runOperator: vi.fn(async () => ({
                outcome: "verification_failed" as const,
                pages: 1,
                processed: 0,
                updated: 0,
                audit: { pages: 1, processed: 1, nullRows: 0, mismatchedRows: 1 },
            })),
            writeOutput,
        })).resolves.toBe(1);

        expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('"outcome":"verification_failed"'));
    });

    it("disconnects the isolated maintenance client when connection fails", async () => {
        const initializationError = new Error("database connect failed");
        const maintenance = createTestMaintenanceClient({ connectError: initializationError });
        const runOperator = vi.fn();

        await expect(runSessionSystemRecordBackfillCommand({
            signal: new AbortController().signal,
            argv: [],
            env: { HAPPIER_DB_PROVIDER: "pglite" },
            createClient: maintenance.createClient,
            runOperator,
        })).rejects.toBe(initializationError);

        expect(maintenance.disconnect).toHaveBeenCalledTimes(1);
        expect(runOperator).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const simpleCacheUpsert = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../sources/storage/db", () => ({
    // Prisma is the storage boundary; the command harness supplies audited
    // operator results so these cases isolate marker-admission behavior.
    db: { simpleCache: { upsert: simpleCacheUpsert } },
    initDbMysql: vi.fn(),
    initDbPglite: vi.fn(),
    initDbPostgres: vi.fn(),
    initDbSqlite: vi.fn(),
    shutdownDbPglite: vi.fn(),
}));

import {
    runSessionTurnTranscriptAnchorProjectionBackfillCommand,
} from "./sessionTurnTranscriptAnchorProjectionBackfill";
import {
    runSessionTurnTranscriptAnchorProjectionBackfillOperator,
} from "../sources/app/session/turns/sessionTurnTranscriptAnchorProjectionBackfillOperator";
import {
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
} from "../sources/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract";

describe("runSessionTurnTranscriptAnchorProjectionBackfillCommand", () => {
    beforeEach(() => {
        simpleCacheUpsert.mockReset();
        simpleCacheUpsert.mockResolvedValue({});
    });

    it("requires exact operator admission before the final writer-floor pass", async () => {
        const initialize = vi.fn(async () => {});

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: { HAPPIER_DB_PROVIDER: "postgres" },
            initialize,
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(),
        })).rejects.toThrow(/exclude.*predecessor writer/i);
        expect(initialize).not.toHaveBeenCalled();
    });

    it("only reports final-contract success after the zero-v0 and factual-projection audit", async () => {
        const writeOutput = vi.fn();

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(async () => ({
                outcome: "drained" as const,
                pages: 2,
                processed: 2,
                updated: 1,
                audit: { pages: 1, processed: 1, legacyRows: 0, mismatchedRows: 0 },
            })),
            writeOutput,
        })).resolves.toBe(0);
        expect(simpleCacheUpsert).toHaveBeenCalledWith({
            where: { key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY },
            create: {
                key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY,
                value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
            },
            update: { value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE },
        });
        expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('"mode":"final-contract"'));
    });

    it("never persists the final marker during an ordinary coexistence backfill", async () => {
        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: new AbortController().signal,
            argv: [],
            env: { HAPPIER_DB_PROVIDER: "postgres" },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(async () => ({
                outcome: "drained" as const,
                pages: 2,
                processed: 2,
                updated: 1,
                audit: { pages: 1, processed: 1, legacyRows: 0, mismatchedRows: 0 },
            })),
            writeOutput: vi.fn(),
        })).resolves.toBe(0);

        expect(simpleCacheUpsert).not.toHaveBeenCalled();
    });

    it("can retry an already-final marker write only after each repeated clean final audit", async () => {
        const runOperator = vi.fn(async () => ({
            outcome: "drained" as const,
            pages: 2,
            processed: 2,
            updated: 0,
            audit: { pages: 1, processed: 1, legacyRows: 0, mismatchedRows: 0 },
        }));
        const options = {
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator,
            writeOutput: vi.fn(),
        };

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand(options)).resolves.toBe(0);
        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand(options)).resolves.toBe(0);

        expect(runOperator).toHaveBeenCalledTimes(2);
        expect(simpleCacheUpsert).toHaveBeenCalledTimes(2);
        expect(simpleCacheUpsert).toHaveBeenLastCalledWith({
            where: { key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY },
            create: {
                key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY,
                value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
            },
            update: { value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE },
        });
    });

    it("does not persist the final marker when the final audit is aborted", async () => {
        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(async () => ({
                outcome: "aborted" as const,
                pages: 2,
                processed: 2,
                updated: 1,
                audit: { pages: 0, processed: 0, legacyRows: 0, mismatchedRows: 0 },
            })),
            writeOutput: vi.fn(),
        })).resolves.toBe(130);

        expect(simpleCacheUpsert).not.toHaveBeenCalled();
    });

    it("does not persist when cancellation fires while a clean final audit query resolves", async () => {
        const controller = new AbortController();
        const runPage = vi.fn()
            .mockResolvedValueOnce({ processed: 1, updated: 1, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 1, updated: 0, nextAfterId: null });
        const runAuditPage = vi.fn(async () => {
            controller.abort();
            return {
                processed: 1,
                legacyRows: 0,
                mismatchedRows: 0,
                nextAfterId: null,
            };
        });

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: controller.signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: async (params) => await runSessionTurnTranscriptAnchorProjectionBackfillOperator({
                ...params,
                runPage,
                runAuditPage,
            }),
            writeOutput: vi.fn(),
        })).resolves.toBe(130);

        expect(runAuditPage).toHaveBeenCalledTimes(1);
        expect(simpleCacheUpsert).not.toHaveBeenCalled();
    });

    it("does not persist when cancellation arrives after an otherwise drained final audit", async () => {
        const controller = new AbortController();

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: controller.signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(async () => {
                controller.abort();
                return {
                    outcome: "drained" as const,
                    pages: 2,
                    processed: 2,
                    updated: 0,
                    audit: { pages: 1, processed: 1, legacyRows: 0, mismatchedRows: 0 },
                };
            }),
            writeOutput: vi.fn(),
        })).resolves.toBe(130);

        expect(simpleCacheUpsert).not.toHaveBeenCalled();
    });

    it("does not admit or persist final-contract after a v0 reappearance or factual mismatch", async () => {
        await expect(runSessionTurnTranscriptAnchorProjectionBackfillCommand({
            signal: new AbortController().signal,
            argv: ["--final-contract"],
            env: {
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL:
                    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
            },
            initialize: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            runOperator: vi.fn(async () => ({
                outcome: "verification_failed" as const,
                pages: 2,
                processed: 2,
                updated: 1,
                audit: { pages: 1, processed: 1, legacyRows: 1, mismatchedRows: 1 },
            })),
            writeOutput: vi.fn(),
        })).resolves.toBe(1);
        expect(simpleCacheUpsert).not.toHaveBeenCalled();
    });
});

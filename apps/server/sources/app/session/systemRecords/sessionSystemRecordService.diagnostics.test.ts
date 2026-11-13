import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../api/testkit/dbMocks";

const logError = vi.hoisted(() => vi.fn());
// Capture the log-output boundary without replacing service/access/transaction logic.
vi.mock("@/utils/logging/log", () => ({
    debug: vi.fn(),
    error: logError,
    warn: vi.fn(),
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionSystemRecord: ["findUnique", "findMany", "findFirst", "create", "update"],
} as const);
const transactions = createDbTransactionMock(() => dbMocks.db);
installDbModuleMock({ db: transactions.wrapDb(dbMocks.db) });

const {
    upsertSessionSystemRecord,
    listSessionSystemRecords,
    getSessionSystemRecord,
    getLatestSessionSystemRecord,
} = await import("./sessionSystemRecordService");

const params = {
    actorUserId: "private-account",
    sessionId: "private-session",
    namespace: "memory",
    kind: "synopsis.v1",
    localId: "private-local-id",
    content: { t: "encrypted", c: "private-ciphertext" },
} as const;

describe("system-record failure diagnostics", () => {
    beforeEach(() => {
        dbMocks.reset();
        logError.mockClear();
        transactions.transaction.mockClear();
        dbMocks.db.session.findUnique.mockResolvedValue({
            accountId: params.actorUserId,
            encryptionMode: "e2ee",
        });
    });

    it.each([
        ["upsert", () => upsertSessionSystemRecord(params), "create"],
        ["list", () => listSessionSystemRecords(params), "findMany"],
        ["get", () => getSessionSystemRecord(params), "findUnique"],
        ["latest", () => getLatestSessionSystemRecord(params), "findFirst"],
    ] as const)("reports %s database failure without private exception data", async (operation, run, method) => {
        const error = Object.assign(new Error("SQL private-prompt private-database-url"), {
            name: "PrismaClientKnownRequestError",
            code: "P2021",
            meta: { query: "private-query", content: params.content },
        });
        dbMocks.db.sessionSystemRecord[method].mockRejectedValue(error);

        expect(await run()).toEqual({ ok: false, error: "internal" });
        expect(logError.mock.calls).toEqual([[
            { module: "session-system-record-service", operation, reason: "exception", prismaCode: "P2021", errorType: "PrismaClientKnownRequestError" },
            expect.any(String),
        ]]);
        expect(JSON.stringify(logError.mock.calls)).not.toContain("private-");
    });

    it("does not copy an arbitrary exception name", async () => {
        dbMocks.db.sessionSystemRecord.findFirst.mockRejectedValue(Object.assign(new Error("private-prompt"), {
            name: "private-error-name",
        }));

        expect(await getLatestSessionSystemRecord(params)).toEqual({ ok: false, error: "internal" });
        expect(logError.mock.calls).toEqual([[
            { module: "session-system-record-service", operation: "latest", reason: "exception", prismaCode: null, errorType: "Error" },
            expect.any(String),
        ]]);
        expect(JSON.stringify(logError.mock.calls)).not.toContain("private-");
    });

    it("reports unknown failures without copying arbitrary error codes", async () => {
        dbMocks.db.sessionSystemRecord.findMany.mockRejectedValue({
            code: "private-secret", message: "private-prompt",
        });

        expect(await listSessionSystemRecords(params)).toEqual({ ok: false, error: "internal" });
        expect(logError.mock.calls).toEqual([[
            { module: "session-system-record-service", operation: "list", reason: "exception", prismaCode: null, errorType: "object" },
            expect.any(String),
        ]]);
        expect(JSON.stringify(logError.mock.calls)).not.toContain("private-");
    });

    it("keeps a recovered unique race silent and reports an exhausted race", async () => {
        const row = { ...params, id: "record", createdAt: new Date(), updatedAt: new Date() };
        const uniqueRace = Object.assign(new Error("private-unique-key"), { code: "P2002" });
        dbMocks.db.sessionSystemRecord.findUnique.mockResolvedValue(null);
        dbMocks.db.sessionSystemRecord.create.mockRejectedValueOnce(uniqueRace).mockResolvedValueOnce(row);

        expect(await upsertSessionSystemRecord(params)).toMatchObject({ ok: true, didCreate: true });
        expect(logError).not.toHaveBeenCalled();

        dbMocks.db.sessionSystemRecord.create.mockRejectedValue(uniqueRace);
        expect(await upsertSessionSystemRecord(params)).toEqual({ ok: false, error: "internal" });
        expect(logError.mock.calls).toEqual([[
            { module: "session-system-record-service", operation: "upsert", reason: "exception", prismaCode: "P2002", errorType: "Error" },
            expect.any(String),
        ]]);
    });

    it.each([
        ["upsert", () => upsertSessionSystemRecord(params), "findUnique"],
        ["list", () => listSessionSystemRecords(params), "findMany"],
        ["get", () => getSessionSystemRecord(params), "findUnique"],
        ["latest", () => getLatestSessionSystemRecord(params), "findFirst"],
    ] as const)("reports %s invalid stored data without copying the rejected row", async (operation, run, method) => {
        const row = { ...params, id: "private-record", content: { t: "plain", v: "private-invalid-payload" },
            createdAt: new Date(), updatedAt: new Date() };
        dbMocks.db.sessionSystemRecord[method].mockResolvedValue(method === "findMany" ? [row] : row);

        expect(await run()).toEqual({ ok: false, error: "internal" });
        expect(logError.mock.calls).toEqual([[
            { module: "session-system-record-service", operation, reason: "invalid-stored-record", prismaCode: null, errorType: null },
            expect.any(String),
        ]]);
        expect(JSON.stringify(logError.mock.calls)).not.toContain("private-");
    });
});

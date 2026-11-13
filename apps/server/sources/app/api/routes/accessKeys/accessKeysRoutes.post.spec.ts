import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    accessKey: ["findUnique", "create"],
    session: ["findFirst"],
    machine: ["findUnique"],
} as const);

const isPrismaErrorCode = vi.fn((error: unknown, code: string) => {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
});

const transactions = createDbTransactionMock(() => ({
    ...inTxPostgresControlStatementMock,
    ...dbMocks.db,
    $queryRawUnsafe: vi.fn(async () => [{ id: "u1" }]),
}));
installDbModuleMock({
    db: transactions.wrapDb(dbMocks.db),
    isPrismaErrorCode,
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const { accessKeysRoutes } = await import("./accessKeysRoutes");

describe("accessKeysRoutes POST /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        isPrismaErrorCode.mockClear();
        dbMocks.db.machine.findUnique.mockResolvedValue({
            accountId: "u1", installationId: null,
            revokedAt: null,
            replacedByMachineId: null,
        });
    });

    it("reports the existing binding after replaying a unique creation race", async () => {
        dbMocks.db.session.findFirst.mockResolvedValue({ accountId: "u1", originKind: "user", originRunId: null });
        dbMocks.db.accessKey.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                data: "winner",
                dataVersion: 1,
                createdAt: new Date("2026-04-19T00:00:00.000Z"),
                updatedAt: new Date("2026-04-19T00:00:00.000Z"),
            });
        dbMocks.db.accessKey.create.mockRejectedValueOnce({ code: "P2002" });

        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke({
            userId: "u1",
            params: { sessionId: "s1", machineId: "m1" },
            body: { data: "created" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "Access key already exists" });

    });

    it("does not create an access key for a replaced machine", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ accountId: "u1", originKind: "user", originRunId: null });
        dbMocks.db.machine.findUnique.mockResolvedValue({
            accountId: "u1", installationId: null,
            revokedAt: null,
            replacedByMachineId: "m2",
        });

        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke({
            userId: "u1",
            params: { sessionId: "s1", machineId: "m1" },
            body: { data: "created" },
        });

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "Session or machine not found" });
        expect(dbMocks.db.accessKey.findUnique).not.toHaveBeenCalled();
        expect(dbMocks.db.accessKey.create).not.toHaveBeenCalled();
    });
});

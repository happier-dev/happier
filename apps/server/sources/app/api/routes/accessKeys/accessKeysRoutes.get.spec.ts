import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    accessKey: ["findUnique"],
    session: ["findFirst"],
    machine: ["findUnique"],
} as const);

const transactions = createDbTransactionMock(() => ({ ...inTxPostgresControlStatementMock, ...dbMocks.db }));
installDbModuleMock({ db: transactions.wrapDb(dbMocks.db) });

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const { accessKeysRoutes } = await import("./accessKeysRoutes");

describe("accessKeysRoutes GET /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        dbMocks.db.machine.findUnique.mockResolvedValue({
            accountId: "u1", installationId: null,
            revokedAt: null,
            replacedByMachineId: null,
        });
    });

    it("checks ownership without loading Session content", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ accountId: "u1", originKind: "user", originRunId: null });
        dbMocks.db.accessKey.findUnique.mockResolvedValueOnce({
            data: "encrypted-key",
            dataVersion: 3,
            createdAt: new Date(1000),
            updatedAt: new Date(2000),
        });

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { sessionId: "s1", machineId: "m1" },
        });

        expect(dbMocks.db.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", accountId: "u1" },
        }));
        expect(dbMocks.db.machine.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1" } }));
        const sessionSelect = dbMocks.db.session.findFirst.mock.calls[0]?.[0].select;
        expect(sessionSelect).not.toHaveProperty("metadata");
        expect(sessionSelect).not.toHaveProperty("dataEncryptionKey");
        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            accessKey: {
                data: "encrypted-key",
                dataVersion: 3,
                createdAt: 1000,
                updatedAt: 2000,
            },
        });
    });

    it("does not expose an access key for a replaced machine", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ accountId: "u1", originKind: "user", originRunId: null });
        dbMocks.db.machine.findUnique.mockResolvedValueOnce({
            accountId: "u1", installationId: null,
            revokedAt: null,
            replacedByMachineId: "m2",
        });

        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { sessionId: "s1", machineId: "m1" },
        });

        expect(reply.statusCode).toBe(404);
        expect(response).toEqual({ error: "Session or machine not found" });
        expect(dbMocks.db.accessKey.findUnique).not.toHaveBeenCalled();
    });
});

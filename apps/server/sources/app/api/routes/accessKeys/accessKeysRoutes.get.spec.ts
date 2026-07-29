import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    accessKey: ["findUnique"],
    session: ["findFirst"],
    machine: ["findFirst"],
} as const);

installDbModuleMock({ db: dbMocks.db });

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accessKeysRoutes GET /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
    });

    it("checks ownership without loading unrelated session or machine fields", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ id: "s1" });
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({ id: "m1" });
        dbMocks.db.accessKey.findUnique.mockResolvedValueOnce({
            data: "encrypted-key",
            dataVersion: 3,
            createdAt: new Date(1000),
            updatedAt: new Date(2000),
        });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
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

        expect(dbMocks.db.session.findFirst).toHaveBeenCalledWith({
            where: { id: "s1", accountId: "u1" },
            select: { id: true },
        });
        expect(dbMocks.db.machine.findFirst).toHaveBeenCalledWith({
            where: { id: "m1", accountId: "u1" },
            select: { id: true },
        });
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    accessKey: ["findUnique", "create"],
    session: ["findFirst"],
    machine: ["findFirst"],
} as const);

const isPrismaErrorCode = vi.fn((error: unknown, code: string) => {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
});

installDbModuleMock({
    db: dbMocks.db,
    isPrismaErrorCode,
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accessKeysRoutes POST /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        isPrismaErrorCode.mockClear();
        dbMocks.db.machine.findFirst.mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
        });
    });

    it("returns the winner row when access-key creation loses a unique race", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ id: "s1", accountId: "u1" });
        dbMocks.db.accessKey.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                data: "winner",
                dataVersion: 1,
                createdAt: new Date("2026-04-19T00:00:00.000Z"),
                updatedAt: new Date("2026-04-19T00:00:00.000Z"),
            });
        dbMocks.db.accessKey.create.mockRejectedValueOnce({ code: "P2002" });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
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

        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({
            success: true,
            accessKey: {
                data: "winner",
                dataVersion: 1,
                createdAt: new Date("2026-04-19T00:00:00.000Z").getTime(),
                updatedAt: new Date("2026-04-19T00:00:00.000Z").getTime(),
            },
        });
    });

    it("does not create an access key for a replaced machine", async () => {
        dbMocks.db.session.findFirst.mockResolvedValueOnce({ id: "s1" });
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({
            revokedAt: null,
            replacedByMachineId: "m2",
        });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const dbMocks = createDbMocks({
    accessKey: ["findUnique", "updateMany", "create"],
    session: ["findFirst"],
    machine: ["findFirst"],
} as const);

installDbModuleMock({ db: dbMocks.db });

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accessKeysRoutes PUT /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
    });

    it("updates with updateMany CAS and returns success", async () => {
        dbMocks.db.accessKey.findUnique.mockResolvedValueOnce({ dataVersion: 2, data: "d2" });
        dbMocks.db.accessKey.updateMany.mockResolvedValueOnce({ count: 1 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const route = createRouteTestBuilder({
            method: "PUT",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
        );

        expect(dbMocks.db.accessKey.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "u1",
                    sessionId: "s1",
                    machineId: "m1",
                    dataVersion: 2,
                }),
                data: expect.objectContaining({
                    data: "d3",
                    dataVersion: 3,
                }),
            }),
        );
        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: true, version: 3 });
    });

    it("returns version-mismatch when expectedVersion differs from current", async () => {
        dbMocks.db.accessKey.findUnique.mockResolvedValueOnce({ dataVersion: 7, data: "d7" });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const route = createRouteTestBuilder({
            method: "PUT",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "dX", expectedVersion: 2 } },
        );

        expect(dbMocks.db.accessKey.updateMany).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: false, error: "version-mismatch", currentVersion: 7, currentData: "d7" });
    });

    it("re-fetches and returns version-mismatch on CAS miss (count=0)", async () => {
        dbMocks.db.accessKey.findUnique
            .mockResolvedValueOnce({ dataVersion: 2, data: "d2" })
            .mockResolvedValueOnce({ dataVersion: 9, data: "d9" });
        dbMocks.db.accessKey.updateMany.mockResolvedValueOnce({ count: 0 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const route = createRouteTestBuilder({
            method: "PUT",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
        );

        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: false, error: "version-mismatch", currentVersion: 9, currentData: "d9" });
    });

    it("returns 404 when CAS miss re-fetch finds no access key", async () => {
        dbMocks.db.accessKey.findUnique.mockResolvedValueOnce({ dataVersion: 2, data: "d2" }).mockResolvedValueOnce(null);
        dbMocks.db.accessKey.updateMany.mockResolvedValueOnce({ count: 0 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const route = createRouteTestBuilder({
            method: "PUT",
            path: "/v1/access-keys/:sessionId/:machineId",
            registerRoutes(app) {
                accessKeysRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
        );

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "Access key not found" });
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const { db, reset: resetDbMocks } = createDbMocks({
    account: ["findUnique"],
    accountChange: ["findMany"],
});

const accountFindUnique = db.account.findUnique;
const accountChangeFindMany = db.accountChange.findMany;

const changesRequestsInc = vi.fn();
const changesReturnedInc = vi.fn();

vi.mock("@/app/monitoring/metrics2", () => ({
    changesRequestsCounter: { inc: changesRequestsInc },
    changesReturnedChangesCounter: { inc: changesReturnedInc },
}));

const debugSpy = vi.fn();
const warnSpy = vi.fn();

vi.mock("@/utils/logging/log", () => ({
    debug: debugSpy,
    warn: warnSpy,
}));

installDbModuleMock(() => ({
    db,
}));

describe("changesRoutes (/v2/changes cursor safety)", () => {
    beforeEach(() => {
        resetDbMocks();
        changesRequestsInc.mockClear();
        changesReturnedInc.mockClear();
        debugSpy.mockClear();
        warnSpy.mockClear();
    });

    it("returns 410 when after is in the future", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 999, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 10 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-in-future" }),
            expect.any(String),
        );
    });

    it("returns 410 when after is behind changesFloor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 50 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 10, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 100 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-behind-floor" }),
            expect.any(String),
        );
    });

    it("returns ordered changes and nextCursor when cursor is valid", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([
            { cursor: 11, kind: "session", entityId: "s1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "machine", entityId: "m1", changedAt: new Date(2), hint: { a: 1 } },
        ]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 10, limit: 10 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({
            changes: [
                { cursor: 11, kind: "session", entityId: "s1", changedAt: 1, hint: null },
                { cursor: 12, kind: "machine", entityId: "m1", changedAt: 2, hint: { a: 1 } },
            ],
            nextCursor: 12,
        });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "ok" });
        expect(changesReturnedInc).toHaveBeenCalledWith(2);
        expect(debugSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", after: 10, nextCursor: 12, returned: 2, limit: 10 }),
            expect.any(String),
        );
    });

    it("returns nextCursor==after when there are no changes", async () => {
        accountFindUnique.mockResolvedValue({ seq: 100, changesFloor: 0 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/changes",
            defaultRequest: { userId: "u1", query: { after: 50, limit: 3 } },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { response } = await route.invoke();

        expect(accountChangeFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { accountId: "u1", cursor: { gt: 50 } },
                orderBy: [{ cursor: "asc" }, { kind: "asc" }, { entityId: "asc" }],
                take: 3,
            }),
        );

        expect(response).toEqual({ changes: [], nextCursor: 50 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "ok" });
        expect(changesReturnedInc).toHaveBeenCalledWith(0);
    });

    it("GET /v2/cursor returns current cursor and changesFloor", async () => {
        accountFindUnique.mockResolvedValue({ seq: 10, changesFloor: 7 });
        accountChangeFindMany.mockResolvedValue([]);

        const { changesRoutes } = await import("./changesRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/cursor",
            defaultRequest: { userId: "u1" },
            registerRoutes(app) {
                changesRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({ cursor: 10, changesFloor: 7 });
    });
});

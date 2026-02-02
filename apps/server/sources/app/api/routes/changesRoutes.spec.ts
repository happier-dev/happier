import { beforeEach, describe, expect, it, vi } from "vitest";

let accountFindUnique: any;
let accountChangeFindMany: any;

const changesRequestsInc = vi.fn();
const changesReturnedInc = vi.fn();

vi.mock("@/app/monitoring/metrics2", () => ({
    changesRequestsCounter: { inc: changesRequestsInc },
    changesReturnedChangesCounter: { inc: changesReturnedInc },
}));

const debugSpy = vi.fn();
const warnSpy = vi.fn();

vi.mock("@/utils/log", () => ({
    debug: debugSpy,
    warn: warnSpy,
}));

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: any[]) => accountFindUnique(...args),
        },
        accountChange: {
            findMany: (...args: any[]) => accountChangeFindMany(...args),
        },
    },
}));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, _opts: any, handler: any) {
        this.routes.set(`GET ${path}`, handler);
    }
    post() {}
}

describe("changesRoutes (/v2/changes cursor safety)", () => {
    beforeEach(() => {
        changesRequestsInc.mockClear();
        changesReturnedInc.mockClear();
        debugSpy.mockClear();
        warnSpy.mockClear();
    });

    it("returns 410 when after is in the future", async () => {
        accountFindUnique = vi.fn(async () => ({ seq: 10, changesFloor: 0 }));
        accountChangeFindMany = vi.fn(async () => []);

        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);

        const handler = app.routes.get("GET /v2/changes");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler({ userId: "u1", query: { after: 999, limit: 10 } }, reply);

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 10 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-in-future" }),
            expect.any(String),
        );
    });

    it("returns 410 when after is behind changesFloor", async () => {
        accountFindUnique = vi.fn(async () => ({ seq: 100, changesFloor: 50 }));
        accountChangeFindMany = vi.fn(async () => []);

        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);

        const handler = app.routes.get("GET /v2/changes");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler({ userId: "u1", query: { after: 10, limit: 10 } }, reply);

        expect(reply.code).toHaveBeenCalledWith(410);
        expect(response).toEqual({ error: "cursor-gone", currentCursor: 100 });
        expect(changesRequestsInc).toHaveBeenCalledWith({ result: "cursor-gone" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: "changes", userId: "u1…", reason: "cursor-behind-floor" }),
            expect.any(String),
        );
    });

    it("returns ordered changes and nextCursor when cursor is valid", async () => {
        accountFindUnique = vi.fn(async () => ({ seq: 100, changesFloor: 0 }));
        accountChangeFindMany = vi.fn(async () => [
            { cursor: 11, kind: "session", entityId: "s1", changedAt: new Date(1), hint: null },
            { cursor: 12, kind: "machine", entityId: "m1", changedAt: new Date(2), hint: { a: 1 } },
        ]);

        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);

        const handler = app.routes.get("GET /v2/changes");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler({ userId: "u1", query: { after: 10, limit: 10 } }, reply);

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
        accountFindUnique = vi.fn(async () => ({ seq: 100, changesFloor: 0 }));
        accountChangeFindMany = vi.fn(async () => []);

        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);

        const handler = app.routes.get("GET /v2/changes");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler({ userId: "u1", query: { after: 50, limit: 3 } }, reply);

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
        accountFindUnique = vi.fn(async () => ({ seq: 10, changesFloor: 7 }));
        accountChangeFindMany = vi.fn(async () => []);

        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);

        const handler = app.routes.get("GET /v2/cursor");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler({ userId: "u1" }, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(response).toEqual({ cursor: 10, changesFloor: 7 });
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewMessageUpdate: vi.fn(),
    buildNewSessionUpdate: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));
const catchupFetchesInc = vi.fn();
const catchupReturnedInc = vi.fn();
vi.mock("@/app/monitoring/metrics2", () => ({
    catchupFollowupFetchesCounter: { inc: catchupFetchesInc },
    catchupFollowupReturnedCounter: { inc: catchupReturnedInc },
}));
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd-id") }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/app/session/sessionWriteService", () => ({ createSessionMessage: vi.fn(), patchSession: vi.fn() }));
vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));

const checkSessionAccess = vi.fn();
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: (...args: any[]) => checkSessionAccess(...args),
}));

const sessionMessageFindMany = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        session: { findMany: vi.fn(async () => []) },
        sessionShare: { findMany: vi.fn(async () => []) },
        sessionMessage: { findMany: (...args: any[]) => sessionMessageFindMany(...args) },
    },
}));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, _opts: any, handler: any) {
        this.routes.set(`GET ${path}`, handler);
    }
    post() {}
    patch() {}
    delete() {}
}

describe("sessionRoutes v1 messages pagination", () => {
    beforeEach(() => {
        catchupFetchesInc.mockClear();
        catchupReturnedInc.mockClear();
    });

    it("returns forward page in ascending order with nextAfterSeq when hasMore", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m3", seq: 3, localId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
            { id: "m4", seq: 4, localId: null, content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m5", seq: 5, localId: null, content: { t: "encrypted", c: "c5" }, createdAt: t0, updatedAt: t0 },
        ]);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v1/sessions/:sessionId/messages");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                query: { afterSeq: 2, limit: 2 },
            },
            reply,
        );

        expect(catchupFetchesInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" });
        expect(catchupReturnedInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" }, 2);

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { sessionId: "s1", seq: { gt: 2 } },
                orderBy: { seq: "asc" },
                take: 3,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, localId: null, createdAt: 1, updatedAt: 1 },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: true,
            nextBeforeSeq: null,
            nextAfterSeq: 4,
        });
    });

    it("returns nextAfterSeq=null when forward page has no more", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m3", seq: 3, localId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v1/sessions/:sessionId/messages");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                query: { afterSeq: 2, limit: 2 },
            },
            reply,
        );

        expect(catchupFetchesInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" });
        expect(catchupReturnedInc).toHaveBeenCalledWith({ type: "session-messages-afterSeq" }, 1);

        expect(res).toEqual({
            messages: [
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy default behavior (backward paging newest-first) when afterSeq is not provided", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m5", seq: 5, localId: null, content: { t: "encrypted", c: "c5" }, createdAt: t0, updatedAt: t0 },
            { id: "m4", seq: 4, localId: null, content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m3", seq: 3, localId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v1/sessions/:sessionId/messages");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                query: { limit: 2 },
            },
            reply,
        );

        expect(catchupFetchesInc).not.toHaveBeenCalled();
        expect(catchupReturnedInc).not.toHaveBeenCalled();

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { sessionId: "s1" },
                orderBy: { seq: "desc" },
                take: 3,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m5", seq: 5, content: { t: "encrypted", c: "c5" }, localId: null, createdAt: 1, updatedAt: 1 },
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: true,
            nextBeforeSeq: 4,
            nextAfterSeq: null,
        });
    });

    it("keeps legacy beforeSeq behavior when afterSeq is not provided", async () => {
        checkSessionAccess.mockResolvedValue({ level: "owner" });

        const t0 = new Date(1);
        sessionMessageFindMany.mockResolvedValue([
            { id: "m4", seq: 4, localId: null, content: { t: "encrypted", c: "c4" }, createdAt: t0, updatedAt: t0 },
            { id: "m3", seq: 3, localId: null, content: { t: "encrypted", c: "c3" }, createdAt: t0, updatedAt: t0 },
        ]);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v1/sessions/:sessionId/messages");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                query: { beforeSeq: 5, limit: 50 },
            },
            reply,
        );

        expect(catchupFetchesInc).not.toHaveBeenCalled();
        expect(catchupReturnedInc).not.toHaveBeenCalled();

        expect(sessionMessageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { sessionId: "s1", seq: { lt: 5 } },
                orderBy: { seq: "desc" },
                take: 51,
            }),
        );

        expect(res).toEqual({
            messages: [
                { id: "m4", seq: 4, content: { t: "encrypted", c: "c4" }, localId: null, createdAt: 1, updatedAt: 1 },
                { id: "m3", seq: 3, content: { t: "encrypted", c: "c3" }, localId: null, createdAt: 1, updatedAt: 1 },
            ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
        });
    });
});

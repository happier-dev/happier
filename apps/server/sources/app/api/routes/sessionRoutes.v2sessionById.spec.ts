import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewMessageUpdate: vi.fn(),
    buildNewSessionUpdate: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd-id") }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/app/share/accessControl", () => ({ checkSessionAccess: vi.fn(async () => ({ level: "owner" })) }));
vi.mock("@/app/session/sessionWriteService", () => ({ createSessionMessage: vi.fn(), patchSession: vi.fn() }));
vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));

const sessionFindFirst = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findMany: vi.fn(async () => []),
            findFirst: (...args: any[]) => sessionFindFirst(...args),
        },
        sessionShare: { findMany: vi.fn(async () => []) },
        sessionMessage: { findMany: vi.fn(async () => []) },
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

describe("sessionRoutes v2 session by id", () => {
    beforeEach(() => {
        sessionFindFirst.mockReset();
    });

    it("returns owned session with raw session DEK and share=null", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s1",
            seq: 1,
            accountId: "u1",
            createdAt: now,
            updatedAt: now,
            metadata: "m1",
            metadataVersion: 2,
            agentState: null,
            agentStateVersion: 3,
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            { userId: "u1", params: { sessionId: "s1" } },
            reply,
        );

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                dataEncryptionKey: "AQID",
                share: null,
            }),
        });
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s2",
            seq: 2,
            accountId: "owner",
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "edit",
                    canApprovePermissions: true,
                },
            ],
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            { userId: "u1", params: { sessionId: "s2" } },
            reply,
        );

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                dataEncryptionKey: "BAU=",
                share: { accessLevel: "edit", canApprovePermissions: true },
            }),
        });
    });

    it("returns 404 when session is not accessible", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            { userId: "u1", params: { sessionId: "missing" } },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
    });
});


import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewMessageUpdate: vi.fn(),
    buildNewSessionUpdate: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd-id") }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/app/share/accessControl", () => ({ checkSessionAccess: vi.fn(async () => ({ level: "owner" })) }));
vi.mock("@/app/session/sessionWriteService", () => ({ createSessionMessage: vi.fn(), patchSession: vi.fn() }));
vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));

const sessionFindMany = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        session: { findMany: (...args: any[]) => sessionFindMany(...args) },
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

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        sessionFindMany.mockReset();
    });

    it("returns owned + shared sessions and uses share DEK for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s3",
                seq: 3,
                accountId: "u1",
                createdAt: now,
                updatedAt: now,
                metadata: "m3",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                active: true,
                lastActiveAt: now,
                shares: [],
            },
            {
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
            },
            {
                id: "s1",
                seq: 1,
                accountId: "u1",
                createdAt: now,
                updatedAt: now,
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: now,
                shares: [],
            },
        ]);

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("GET /v2/sessions");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                query: { limit: 2 },
            },
            reply,
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s3",
                    dataEncryptionKey: "AQID",
                    share: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    dataEncryptionKey: "BAU=",
                    share: { accessLevel: "edit", canApprovePermissions: true },
                }),
            ],
            nextCursor: "cursor_v1_s2",
            hasNext: true,
        });
    });
});


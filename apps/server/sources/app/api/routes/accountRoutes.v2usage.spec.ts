import { beforeEach, describe, expect, it, vi } from "vitest";

const emitEphemeral = vi.fn();
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral },
    buildUpdateAccountUpdate: vi.fn(),
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));

vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd-id") }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/storage/files", () => ({ getPublicUrl: vi.fn((p: string) => p) }));

const dbSessionFindFirst = vi.fn();
const dbUsageUpsert = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        account: { findUniqueOrThrow: vi.fn(async () => ({ firstName: "", lastName: "", username: "", avatar: null, githubUser: null })) },
        serviceAccountToken: { findMany: vi.fn(async () => []) },
        session: { findFirst: (...args: any[]) => dbSessionFindFirst(...args) },
        usageReport: { upsert: (...args: any[]) => dbUsageUpsert(...args) },
    },
}));

vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/types", () => ({ AccountProfile: {} }));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
}

describe("accountRoutes v2 usage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbSessionFindFirst.mockResolvedValue({ id: "s1" });
        dbUsageUpsert.mockResolvedValue({ id: "r1", createdAt: new Date(1), updatedAt: new Date(2) });
    });

    it("upserts usage report and emits ephemeral when sessionId is provided", async () => {
        const { accountRoutes } = await import("./accountRoutes");
        const app = new FakeApp();
        accountRoutes(app as any);

        const handler = app.routes.get("POST /v2/usage-reports");
        expect(typeof handler).toBe("function");

        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
        const res = await handler(
            {
                userId: "u1",
                body: {
                    key: "k1",
                    sessionId: "s1",
                    tokens: { total: 10, prompt: 5 },
                    cost: { total: 0.1 },
                },
            },
            reply,
        );

        expect(dbUsageUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { accountId_sessionId_key: { accountId: "u1", sessionId: "s1", key: "k1" } },
            }),
        );
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ success: true, reportId: "r1", createdAt: 1, updatedAt: 2 });
    });

    it("returns 404 when sessionId does not belong to user", async () => {
        dbSessionFindFirst.mockResolvedValueOnce(null);

        const { accountRoutes } = await import("./accountRoutes");
        const app = new FakeApp();
        accountRoutes(app as any);

        const handler = app.routes.get("POST /v2/usage-reports");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            {
                userId: "u1",
                body: { key: "k1", sessionId: "s1", tokens: { total: 1 }, cost: { total: 1 } },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn((_msg: any, _sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-message" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildNewSessionUpdate: vi.fn(),
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const createSessionMessage = vi.fn();
const patchSession = vi.fn();
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage: (...args: any[]) => createSessionMessage(...args),
    patchSession: (...args: any[]) => patchSession(...args),
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: { findMany: vi.fn(async () => []) },
        sessionShare: { findMany: vi.fn(async () => []) },
        sessionMessage: { findMany: vi.fn(async () => []) },
    },
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
vi.mock("@/app/share/accessControl", () => ({ checkSessionAccess: vi.fn(async () => ({ level: "owner" })) }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
    patch(path: string, _opts: any, handler: any) {
        this.routes.set(`PATCH ${path}`, handler);
    }
    delete(path: string, _opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, handler);
    }
}

describe("sessionRoutes v2 messages", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates a message via service and emits updates using returned cursors", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            message: { id: "m1", seq: 10, localId: "l1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [
                { accountId: "u1", cursor: 111 },
                { accountId: "u2", cursor: 222 },
            ],
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("POST /v2/sessions/:sessionId/messages");
        expect(typeof handler).toBe("function");

        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                headers: {},
                body: { ciphertext: "cipher", localId: "l1" },
            },
            reply,
        );

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 111, expect.any(String));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 222, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            message: { id: "m1", seq: 10, localId: "l1", createdAt: createdAt.getTime() },
        });
    });

    it("uses Idempotency-Key header as localId when body.localId is missing", async () => {
        const createdAt = new Date(1);
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: false,
            message: { id: "m1", seq: 10, localId: "idem-1", createdAt },
            participantCursors: [],
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("POST /v2/sessions/:sessionId/messages");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                headers: { "idempotency-key": "idem-1" },
                body: { ciphertext: "cipher" },
            },
            reply,
        );

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "idem-1",
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("maps service errors to status codes", async () => {
        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);
        const handler = app.routes.get("POST /v2/sessions/:sessionId/messages");

        const mkReply = () => {
            const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
            return reply;
        };

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const r1 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "" } }, r1);
        expect(r1.code).toHaveBeenCalledWith(400);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "forbidden" });
        const r2 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } }, r2);
        expect(r2.code).toHaveBeenCalledWith(403);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "session-not-found" });
        const r3 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } }, r3);
        expect(r3.code).toHaveBeenCalledWith(404);
    });
});

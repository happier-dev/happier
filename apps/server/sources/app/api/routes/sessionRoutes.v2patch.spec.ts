import { beforeEach, describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildUpdateSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-session" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate: vi.fn(),
    buildNewSessionUpdate: vi.fn(),
    buildUpdateSessionUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const patchSession = vi.fn();
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage: vi.fn(),
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

describe("sessionRoutes v2 patch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("emits update-session using returned per-recipient cursors", async () => {
        patchSession.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadata: { version: 2, value: "mNew" },
            agentState: { version: 3, value: null },
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("PATCH /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                    agentState: { ciphertext: null, expectedVersion: 2 },
                },
            },
            reply,
        );

        expect(patchSession).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            metadata: { ciphertext: "mNew", expectedVersion: 1 },
            agentState: { ciphertext: null, expectedVersion: 2 },
        });

        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            10,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            11,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            success: true,
            metadata: { version: 2 },
            agentState: { version: 3 },
        });
    });

    it("passes through version-mismatch current values", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: { metadata: { version: 9, value: "m9" } },
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("PATCH /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                },
            },
            reply,
        );

        expect(res).toEqual({
            success: false,
            error: "version-mismatch",
            metadata: { version: 9, value: "m9" },
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns 500 on version-mismatch when current state is missing", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: null,
        });

        const { sessionRoutes } = await import("./sessionRoutes");
        const app = new FakeApp();
        sessionRoutes(app as any);

        const handler = app.routes.get("PATCH /v2/sessions/:sessionId");
        const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(res).toEqual({ error: "Failed to update session" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});

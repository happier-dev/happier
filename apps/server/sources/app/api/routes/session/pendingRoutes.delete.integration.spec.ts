import { beforeEach, describe, expect, it, vi } from "vitest";

const deletePendingMessage = vi.fn();

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    deletePendingMessage,
}));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, _opts: any, handler: any) {
        this.routes.set(`GET ${path}`, handler);
    }
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
    put(path: string, _opts: any, handler: any) {
        this.routes.set(`PUT ${path}`, handler);
    }
    patch(path: string, _opts: any, handler: any) {
        this.routes.set(`PATCH ${path}`, handler);
    }
    delete(path: string, _opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, handler);
    }
}

function replyStub() {
    const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
    return reply;
}

describe("sessionPendingRoutes (delete) (status mapping)", () => {
    beforeEach(() => {
        vi.resetModules();
        deletePendingMessage.mockReset();
    });

    it("returns success when pending localId is already absent", async () => {
        deletePendingMessage.mockResolvedValueOnce({
            ok: true,
            pendingCount: 3,
            pendingVersion: 7,
            participantCursors: [],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const app = new FakeApp();
        sessionPendingRoutes(app as any);

        const handler = app.routes.get("DELETE /v2/sessions/:sessionId/pending/:localId");
        const reply = replyStub();
        await handler({ userId: "actor", params: { sessionId: "s1", localId: "l1" } }, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).toHaveBeenCalledWith({ ok: true, pendingCount: 3, pendingVersion: 7 });
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.fn();
const deleteOne = vi.fn(() => {
    throw new Error("not-found");
});
const findUnique = vi.fn<(...args: any[]) => Promise<{ metadata: unknown } | null>>(async () => null);

vi.mock("@/storage/db", () => ({
    db: {
        serviceAccountToken: {
            findUnique,
            delete: deleteOne,
            deleteMany,
        },
    },
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
    delete(path: string, _opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, handler);
    }
}

function replyStub() {
    const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
    return reply;
}

describe("connectRoutes (vendor token delete)", () => {
    beforeEach(() => {
        vi.resetModules();
        deleteMany.mockReset();
        deleteOne.mockClear();
        findUnique.mockReset();
        findUnique.mockResolvedValue(null);
    });

    it("treats DELETE /v1/connect/:vendor as idempotent when the token is missing", async () => {
        const { connectRoutes } = await import("./connectRoutes");
        const app = new FakeApp();
        connectRoutes(app as any);

        const handler = app.routes.get("DELETE /v1/connect/:vendor");
        const reply = replyStub();

        await handler({ userId: "u1", params: { vendor: "openai" } }, reply);

        expect(deleteMany).toHaveBeenCalledWith({
            where: { accountId: "u1", vendor: "openai", profileId: "default" },
        });
        expect(reply.send).toHaveBeenCalledWith({ success: true });
    });

    it("returns 409 when a v2 credential exists for the vendor", async () => {
        const { connectRoutes } = await import("./connectRoutes");
        const app = new FakeApp();
        connectRoutes(app as any);

        const handler = app.routes.get("DELETE /v1/connect/:vendor");
        const reply = replyStub();

        findUnique.mockResolvedValue({
            metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" },
        });

        await handler({ userId: "u1", params: { vendor: "openai" } }, reply);

        expect(deleteMany).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({ error: "connect_credential_conflict" });
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const accessKeyFindUnique = vi.fn();
const accessKeyUpdateMany = vi.fn();
const sessionFindFirst = vi.fn();
const machineFindFirst = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        accessKey: {
            findUnique: (...args: any[]) => accessKeyFindUnique(...args),
            updateMany: (...args: any[]) => accessKeyUpdateMany(...args),
            create: vi.fn(),
        },
        session: { findFirst: (...args: any[]) => sessionFindFirst(...args) },
        machine: { findFirst: (...args: any[]) => machineFindFirst(...args) },
    },
}));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post() {}
    put(path: string, _opts: any, handler: any) {
        this.routes.set(`PUT ${path}`, handler);
    }
    delete() {}
}

function makeReply() {
    const reply: any = {
        statusCode: 200,
        code: vi.fn((status: number) => {
            reply.statusCode = status;
            return reply;
        }),
        send: vi.fn((p: any) => p),
    };
    return reply;
}

describe("accessKeysRoutes PUT /v1/access-keys/:sessionId/:machineId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("updates with updateMany CAS and returns success", async () => {
        accessKeyFindUnique.mockResolvedValueOnce({ dataVersion: 2, data: "d2" });
        accessKeyUpdateMany.mockResolvedValueOnce({ count: 1 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const app = new FakeApp();
        accessKeysRoutes(app as any);

        const handler = app.routes.get("PUT /v1/access-keys/:sessionId/:machineId");
        const reply = makeReply();

        const res = await handler(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
            reply,
        );

        expect(accessKeyUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "u1",
                    sessionId: "s1",
                    machineId: "m1",
                    dataVersion: 2,
                }),
                data: expect.objectContaining({
                    data: "d3",
                    dataVersion: 3,
                }),
            }),
        );
        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: true, version: 3 });
    });

    it("returns version-mismatch when expectedVersion differs from current", async () => {
        accessKeyFindUnique.mockResolvedValueOnce({ dataVersion: 7, data: "d7" });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const app = new FakeApp();
        accessKeysRoutes(app as any);

        const handler = app.routes.get("PUT /v1/access-keys/:sessionId/:machineId");
        const reply = makeReply();

        const res = await handler(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "dX", expectedVersion: 2 } },
            reply,
        );

        expect(accessKeyUpdateMany).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: false, error: "version-mismatch", currentVersion: 7, currentData: "d7" });
    });

    it("re-fetches and returns version-mismatch on CAS miss (count=0)", async () => {
        accessKeyFindUnique
            .mockResolvedValueOnce({ dataVersion: 2, data: "d2" })
            .mockResolvedValueOnce({ dataVersion: 9, data: "d9" });
        accessKeyUpdateMany.mockResolvedValueOnce({ count: 0 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const app = new FakeApp();
        accessKeysRoutes(app as any);

        const handler = app.routes.get("PUT /v1/access-keys/:sessionId/:machineId");
        const reply = makeReply();

        const res = await handler(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
            reply,
        );

        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({ success: false, error: "version-mismatch", currentVersion: 9, currentData: "d9" });
    });

    it("returns 404 when CAS miss re-fetch finds no access key", async () => {
        accessKeyFindUnique.mockResolvedValueOnce({ dataVersion: 2, data: "d2" }).mockResolvedValueOnce(null);
        accessKeyUpdateMany.mockResolvedValueOnce({ count: 0 });

        const { accessKeysRoutes } = await import("./accessKeysRoutes");
        const app = new FakeApp();
        accessKeysRoutes(app as any);

        const handler = app.routes.get("PUT /v1/access-keys/:sessionId/:machineId");
        const reply = makeReply();

        const res = await handler(
            { userId: "u1", params: { sessionId: "s1", machineId: "m1" }, body: { data: "d3", expectedVersion: 2 } },
            reply,
        );

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "Access key not found" });
    });
});


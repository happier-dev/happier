import { beforeEach, describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildNewArtifactUpdate = vi.fn((_artifact: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-artifact" },
}));
const buildUpdateArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-artifact" },
}));
const buildDeleteArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "delete-artifact" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 700);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

const dbArtifactFindUnique = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        artifact: {
            findMany: vi.fn(async () => []),
            findFirst: vi.fn(async () => null),
            findUnique: (...args: any[]) => dbArtifactFindUnique(...args),
        },
    },
}));

let txArtifactFindFirst: any;
let txArtifactFindUnique: any;
let txArtifactCreate: any;
let txArtifactUpdateMany: any;
let txArtifactDelete: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            artifact: {
                findFirst: (...args: any[]) => txArtifactFindFirst(...args),
                findUnique: (...args: any[]) => txArtifactFindUnique(...args),
                create: (...args: any[]) => txArtifactCreate(...args),
                updateMany: (...args: any[]) => txArtifactUpdateMany(...args),
                delete: (...args: any[]) => txArtifactDelete(...args),
            },
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
    delete(path: string, _opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, handler);
    }
}

describe("artifactsRoutes (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        dbArtifactFindUnique.mockResolvedValue(null);
        txArtifactFindFirst = vi.fn();
        txArtifactFindUnique = vi.fn();
        txArtifactCreate = vi.fn();
        txArtifactUpdateMany = vi.fn();
        txArtifactDelete = vi.fn();
    });

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        txArtifactFindUnique.mockResolvedValue(null);
        txArtifactCreate.mockResolvedValue({
            id: "a1",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from("k"),
            seq: 0,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { artifactsRoutes } = await import("./artifactsRoutes");
        const app = new FakeApp();
        artifactsRoutes(app as any);

        const handler = app.routes.get("POST /v1/artifacts");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            { userId: "u1", body: { id: "a1", header: "aGVhZA==", body: "Ym9keQ==", dataEncryptionKey: "a2V5" } },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a1" }),
        );
        expect(buildNewArtifactUpdate).toHaveBeenCalledWith(expect.anything(), 700, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("marks artifact update and emits update-artifact using returned cursor", async () => {
        txArtifactFindFirst.mockResolvedValue({
            id: "a2",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from("k"),
            seq: 7,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txArtifactUpdateMany.mockResolvedValue({ count: 1 });

        const { artifactsRoutes } = await import("./artifactsRoutes");
        const app = new FakeApp();
        artifactsRoutes(app as any);

        const handler = app.routes.get("POST /v1/artifacts/:id");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler(
            { userId: "u1", params: { id: "a2" }, body: { header: "aGVsbG8=", expectedHeaderVersion: 1 } },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a2" }),
        );
        expect(buildUpdateArtifactUpdate).toHaveBeenCalledWith("a2", 700, expect.any(String), { value: "aGVsbG8=", version: 2 }, undefined);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(response).toEqual(expect.objectContaining({ success: true, headerVersion: 2 }));
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        txArtifactFindFirst.mockResolvedValue({ id: "a3" });
        txArtifactDelete.mockResolvedValue({ id: "a3" });

        const { artifactsRoutes } = await import("./artifactsRoutes");
        const app = new FakeApp();
        artifactsRoutes(app as any);

        const handler = app.routes.get("DELETE /v1/artifacts/:id");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler({ userId: "u1", params: { id: "a3" } }, reply);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a3" }),
        );
        expect(buildDeleteArtifactUpdate).toHaveBeenCalledWith("a3", 700, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});

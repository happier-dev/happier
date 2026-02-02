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

const markAccountChanged = vi.fn(async () => 555);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics2", () => ({
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

let txArtifactFindFirst: any;
let txArtifactFindUnique: any;
let txArtifactUpdateMany: any;
let txArtifactCreate: any;
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
                updateMany: (...args: any[]) => txArtifactUpdateMany(...args),
                create: (...args: any[]) => txArtifactCreate(...args),
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

const dbArtifactFindUnique = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        artifact: {
            findUnique: (...args: any[]) => dbArtifactFindUnique(...args),
        },
    },
}));

class FakeSocket {
    public handlers = new Map<string, any>();

    on(event: string, handler: any) {
        this.handlers.set(event, handler);
    }
}

describe("artifactUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        dbArtifactFindUnique.mockResolvedValue(null);
        txArtifactFindFirst = vi.fn();
        txArtifactFindUnique = vi.fn();
        txArtifactUpdateMany = vi.fn();
        txArtifactCreate = vi.fn();
        txArtifactDelete = vi.fn();
    });

    it("marks artifact update and emits update using returned cursor", async () => {
        txArtifactFindFirst.mockResolvedValue({
            id: "a1",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 2,
            dataEncryptionKey: Buffer.from("k"),
            seq: 7,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txArtifactUpdateMany.mockResolvedValue({ count: 1 });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = new FakeSocket();
        artifactUpdateHandler("u1", socket as any);

        const handler = socket.handlers.get("artifact-update");
        expect(typeof handler).toBe("function");

        const callback = vi.fn();
        await handler(
            {
                artifactId: "a1",
                header: { data: "aGVsbG8=", expectedVersion: 1 },
                body: { data: "d29ybGQ=", expectedVersion: 2 },
            },
            callback,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a1" }),
        );
        expect(buildUpdateArtifactUpdate).toHaveBeenCalledWith(
            "a1",
            555,
            expect.any(String),
            { value: "aGVsbG8=", version: 2 },
            { value: "d29ybGQ=", version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                header: { version: 2, data: "aGVsbG8=" },
                body: { version: 3, data: "d29ybGQ=" },
            }),
        );
    });

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        txArtifactFindUnique.mockResolvedValue(null);
        txArtifactCreate.mockResolvedValue({
            id: "a2",
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

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = new FakeSocket();
        artifactUpdateHandler("u1", socket as any);

        const handler = socket.handlers.get("artifact-create");
        expect(typeof handler).toBe("function");

        const callback = vi.fn();
        await handler({ id: "a2", header: "aGVhZA==", body: "Ym9keQ==", dataEncryptionKey: "a2V5" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a2" }),
        );
        expect(buildNewArtifactUpdate).toHaveBeenCalledWith(expect.anything(), 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                artifact: expect.objectContaining({ id: "a2", headerVersion: 1, bodyVersion: 1 }),
            }),
        );
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        txArtifactFindFirst.mockResolvedValue({ id: "a3" });
        txArtifactDelete.mockResolvedValue({ id: "a3" });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = new FakeSocket();
        artifactUpdateHandler("u1", socket as any);

        const handler = socket.handlers.get("artifact-delete");
        expect(typeof handler).toBe("function");

        const callback = vi.fn();
        await handler({ artifactId: "a3" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a3" }),
        );
        expect(buildDeleteArtifactUpdate).toHaveBeenCalledWith("a3", 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ result: "success" });
    });
});

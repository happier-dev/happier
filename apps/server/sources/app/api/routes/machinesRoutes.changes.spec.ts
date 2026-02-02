import { describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildNewMachineUpdate = vi.fn((_created: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-machine" },
}));
const buildUpdateMachineUpdate = vi.fn((_machineId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-machine" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMachineUpdate,
    buildUpdateMachineUpdate,
}));

const randomKeyNaked = vi.fn()
    .mockReturnValueOnce("upd-1")
    .mockReturnValueOnce("upd-2");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 123);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: vi.fn(async () => null),
        },
    },
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            machine: {
                create: vi.fn(async (args: any) => ({
                    ...args.data,
                    seq: 0,
                    lastActiveAt: new Date(1),
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                })),
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
    public postHandlers = new Map<string, any>();
    public get = vi.fn();

    post(path: string, _opts: any, handler: any) {
        this.postHandlers.set(path, handler);
    }
}

describe("machinesRoutes (AccountChange integration)", () => {
    it("marks machine create once and emits new-machine + update-machine using the same cursor", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = new FakeApp();
        machinesRoutes(app as any);

        const handler = app.postHandlers.get("/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = {
            send: vi.fn((payload: any) => payload),
            code: vi.fn(() => reply),
        };

        const response = await handler(
            {
                userId: "u1",
                body: { id: "m1", metadata: "meta", daemonState: "state", dataEncryptionKey: null },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "machine", entityId: "m1" }),
        );

        expect(buildNewMachineUpdate).toHaveBeenCalledWith(expect.anything(), 123, "upd-1");
        expect(buildUpdateMachineUpdate).toHaveBeenCalledWith("m1", 123, "upd-2", { version: 1, value: "meta" });
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(reply.send).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1", metadata: "meta", metadataVersion: 1, daemonState: "state", daemonStateVersion: 1 }),
            }),
        );
    });
});


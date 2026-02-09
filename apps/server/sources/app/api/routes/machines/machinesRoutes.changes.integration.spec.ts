import { describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";

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
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 123);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: vi.fn(async () => null),
        },
    },
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({
            machine: {
                create: vi.fn(async (args: any) => ({
                    ...args.data,
                    seq: 0,
                    lastActiveAt: new Date(1),
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                })),
            },
        }));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

describe("machinesRoutes (AccountChange integration)", () => {
    it("marks machine create once and emits new-machine + update-machine using the same cursor", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = createReplyStub();

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

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                payload: expect.objectContaining({
                    seq: 123,
                    body: expect.objectContaining({ t: "new-machine" }),
                }),
            }),
        );
        expect(emitUpdate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                payload: expect.objectContaining({
                    seq: 123,
                    body: expect.objectContaining({ t: "update-machine" }),
                }),
            }),
        );

        expect(reply.send).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1", metadata: "meta", metadataVersion: 1, daemonState: "state", daemonStateVersion: 1 }),
            }),
        );
    });
});

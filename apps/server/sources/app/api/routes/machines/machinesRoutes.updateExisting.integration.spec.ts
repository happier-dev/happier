import { describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";

const markAccountChanged = vi.fn(async () => 123);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

// Keep event routing out of scope for this behavior test.
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewMachineUpdate: vi.fn(),
    buildUpdateMachineUpdate: vi.fn(),
}));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));

const existingMachine = {
    id: "m1",
    accountId: "u1",
    metadata: "meta-old",
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    dataEncryptionKey: new Uint8Array([0, 9, 9, 9]),
    seq: 1,
    active: true,
    lastActiveAt: new Date(1),
    createdAt: new Date(1),
    updatedAt: new Date(1),
};

const dbMachineFindFirst = vi.fn(async () => existingMachine);

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: dbMachineFindFirst,
            findUnique: vi.fn(async () => null),
        },
    },
    isPrismaErrorCode: () => false,
}));

const txMachineUpdate = vi.fn(async (args: any) => ({
    ...existingMachine,
    ...args.data,
    lastActiveAt: new Date(),
    updatedAt: new Date(),
}));

const harness = createInTxHarness(() => ({
    accessKey: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    machine: {
        create: vi.fn(async () => { throw new Error("unexpected create"); }),
        findFirst: vi.fn(async () => existingMachine),
        update: txMachineUpdate,
    },
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (update existing machine)", () => {
    it("updates dataEncryptionKey when machine already exists for the authenticated account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                body: {
                    id: "m1",
                    metadata: "meta-old",
                    daemonState: undefined,
                    // base64 for bytes [0,1,2,3]
                    dataEncryptionKey: "AAECAw==",
                },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "machine", entityId: "m1" }),
        );

        expect(txMachineUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                // Ensure the update writes the new key instead of leaving stale state.
                dataEncryptionKey: expect.any(Uint8Array),
            }),
        }));

        expect(reply.send).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({
                    id: "m1",
                    metadata: "meta-old",
                    dataEncryptionKey: "AAECAw==",
                }),
            }),
        );
    });
});

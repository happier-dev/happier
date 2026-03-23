import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
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

const dbMocks = createDbMocks({
    machine: ["findFirst", "findUnique"],
    account: ["findUnique"],
} as const);
const txDbMocks = createDbMocks({
    accessKey: ["deleteMany"],
    machine: ["create", "findFirst", "update"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: () => false,
}));

const harness = createInTxHarness(() => ({
    accessKey: txDbMocks.db.accessKey,
    machine: txDbMocks.db.machine,
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (update existing machine)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        dbMocks.db.account.findUnique.mockResolvedValue({ contentPublicKey: new Uint8Array(32).fill(7) });
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.machine.create.mockImplementation(async () => { throw new Error("unexpected create"); });
        txDbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        txDbMocks.db.machine.update.mockImplementation(async (args: any) => ({
            ...existingMachine,
            ...args.data,
            lastActiveAt: new Date(),
            updatedAt: new Date(),
        }));
    });

    it("updates dataEncryptionKey when machine already exists for the authenticated account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke(
            {
                userId: "u1",
                body: {
                    id: "m1",
                    metadata: "meta-old",
                    daemonState: undefined,
                    // base64 for bytes [0,1,2,3]
                    dataEncryptionKey: "AAECAw==",
                    contentPublicKey: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
                },
            },
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "machine", entityId: "m1" }),
        );

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
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

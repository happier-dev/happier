import { describe, expect, it, vi } from "vitest";
import { MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

const markAccountChanged = vi.fn(async () => 456);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/changes/markAccountChangedAfterCommit", () => ({ markAccountChangedAfterCommit: vi.fn(async () => 456) }));

const emitUpdate = vi.fn();
const buildUpdateMachineUpdate = vi.fn((_machineId: string, updSeq: number, updId: string, _metadata?: any, _daemonState?: any, extra?: any) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-machine", ...extra },
    createdAt: 0,
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMachineUpdate: vi.fn(),
    buildUpdateMachineUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const invalidateMachine = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { invalidateMachine },
}));

const removeAutomationMachineAssignmentsTx = vi.fn(async (params: Readonly<{
    tx: unknown;
    markMachineUnavailableTx: (tx: unknown) => Promise<void>;
}>) => {
    await params.markMachineUnavailableTx(params.tx);
    return {
        affectedAutomationIds: [],
        disabledAutomationIds: [],
    };
});
vi.mock("@/app/automations/automationMachineAssignmentRemoval", () => ({
    removeAutomationMachineAssignmentsTx,
}));

const existingMachine = {
    id: "m1",
    accountId: "u1",
    metadata: "meta",
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    dataEncryptionKey: null,
    seq: 1,
    active: true,
    lastActiveAt: new Date(1000),
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    revokedAt: null as Date | null,
};

const dbMocks = createDbMocks({
    machine: ["findFirst"],
} as const);
const txDbMocks = createDbMocks({
    machine: ["findFirst", "update"],
    accessKey: ["deleteMany"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: () => false,
}));

const harness = createInTxHarness(() => ({
    machine: txDbMocks.db.machine,
    accessKey: txDbMocks.db.accessKey,
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (revoke machine)", () => {
    it("marks a machine revoked and deletes its access keys", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        dbMocks.reset();
        txDbMocks.reset();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        txDbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        txDbMocks.db.machine.update.mockImplementation(async (args: any) => ({
            ...existingMachine,
            ...args.data,
            updatedAt: new Date(),
        }));
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 2 });
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/:id/revoke",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke(
            {
                userId: "u1",
                params: { id: "m1" },
            },
        );

        expect(txDbMocks.db.accessKey.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "u1", machineId: "m1" }),
        }));
        // Definition assignments are removed through the canonical
        // Automation-owned machine-assignment removal composition.
        expect(removeAutomationMachineAssignmentsTx).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: "u1", machineId: "m1" }),
        );
        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                active: false,
                revokedAt: expect.any(Date),
            }),
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "machine", entityId: "m1" }),
        );
        expect(buildUpdateMachineUpdate).toHaveBeenCalledWith(
            "m1",
            456,
            "upd",
            undefined,
            undefined,
            expect.objectContaining({ revokedAt: expect.any(Number), active: false }),
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(invalidateMachine).toHaveBeenCalledWith("m1");

        expect(reply.send).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({
                    id: "m1",
                    active: false,
                    revokedAt: expect.any(Number),
                }),
            }),
        );
    });

    it("does not revoke a marked Machine for a legacy caller", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        markAccountChanged.mockClear();
        removeAutomationMachineAssignmentsTx.mockClear();
        dbMocks.reset();
        txDbMocks.reset();
        const markedMachine = {
            ...existingMachine,
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        txDbMocks.db.machine.findFirst.mockResolvedValue(markedMachine);
        txDbMocks.db.machine.update.mockResolvedValue({
            ...markedMachine,
            active: false,
            revokedAt: new Date(),
        });
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/:id/revoke",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                outcome: "legacy-missing",
            },
            params: { id: "m1" },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
        expect(txDbMocks.db.accessKey.deleteMany).not.toHaveBeenCalled();
        expect(removeAutomationMachineAssignmentsTx).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });
});

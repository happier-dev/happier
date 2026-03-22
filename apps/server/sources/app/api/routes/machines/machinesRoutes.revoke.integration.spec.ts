import { describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

const markAccountChanged = vi.fn(async () => 456);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

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
    automationAssignment: ["deleteMany"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: () => false,
}));

const harness = createInTxHarness(() => ({
    machine: txDbMocks.db.machine,
    accessKey: txDbMocks.db.accessKey,
    automationAssignment: txDbMocks.db.automationAssignment,
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
        txDbMocks.db.automationAssignment.deleteMany.mockResolvedValue({ count: 1 });
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
        expect(txDbMocks.db.automationAssignment.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ machineId: "m1" }),
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
});

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

const dbMocks = createDbMocks({
    machine: ["findFirst"],
    accessKey: ["deleteMany"],
} as const);
const txDbMocks = createDbMocks({
    accessKey: ["deleteMany"],
    machine: ["create", "update"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: (e: any, code: string) => e?.code === code,
}));

const harness = createInTxHarness(() => ({
    accessKey: txDbMocks.db.accessKey,
    machine: txDbMocks.db.machine,
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (machine id conflict)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        dbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.machine.create.mockImplementation(async () => {
            throw new Error("unexpected create");
        });
        txDbMocks.db.machine.update.mockImplementation(async (args: any) => ({
            id: args.where.id,
            accountId: args.data.accountId,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            active: args.data.active ?? true,
            lastActiveAt: new Date(),
            createdAt: new Date(1),
            updatedAt: new Date(),
        }));
    });

    it("returns 409 when create races (P2002) and the machine id belongs to a different account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        txDbMocks.db.machine.create.mockRejectedValueOnce(Object.assign(new Error("P2002"), { code: "P2002" }));
        const { response, reply } = await route.invoke(
            {
                userId: "u_new",
                body: { id: "m1", metadata: "meta-new", daemonState: "state-new", dataEncryptionKey: null },
            },
        );

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            error: "machine_id_conflict",
            message: expect.any(String),
        });

        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("returns the existing machine when create races (P2002) and the machine id belongs to the same account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        const existingSameAccount = {
            id: "m1",
            accountId: "u_new",
            metadata: "old",
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: null,
            seq: 1,
            active: true,
            lastActiveAt: new Date(1),
            createdAt: new Date(1),
            updatedAt: new Date(1),
        };
        // First lookup misses, then the P2002 handler finds the row for this account.
        dbMocks.db.machine.findFirst.mockResolvedValueOnce(null as any);
        dbMocks.db.machine.findFirst.mockResolvedValueOnce(existingSameAccount as any);
        txDbMocks.db.machine.create.mockRejectedValueOnce(Object.assign(new Error("P2002"), { code: "P2002" }));

        const { response, reply } = await route.invoke(
            { userId: "u_new", body: { id: "m1", metadata: "meta-new", daemonState: undefined, dataEncryptionKey: null } },
        );

        expect(reply.code).not.toHaveBeenCalledWith(409);
        expect((response as any)?.machine?.id).toBe("m1");
    });
});

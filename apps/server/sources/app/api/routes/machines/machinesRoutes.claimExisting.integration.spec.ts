import { afterEach, describe, expect, it, vi } from "vitest";
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

const dbMachineFindFirst = vi.fn(async () => null);

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: dbMachineFindFirst,
        },
        accessKey: {
            deleteMany: vi.fn(async () => ({ count: 0 })),
        },
    },
    isPrismaErrorCode: (e: any, code: string) => e?.code === code,
}));

const txMachineCreate = vi.fn(async () => {
    throw new Error("unexpected create");
});

const txMachineUpdate = vi.fn(async (args: any) => ({
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

const harness = createInTxHarness(() => ({
    accessKey: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    machine: {
        create: txMachineCreate,
        update: txMachineUpdate,
    },
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (machine id conflict)", () => {
    afterEach(() => {
        // no-op
    });

    it("returns 409 when create races (P2002) and the machine id belongs to a different account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = createReplyStub();
        txMachineCreate.mockRejectedValueOnce(Object.assign(new Error("P2002"), { code: "P2002" }));
        const response = await handler(
            {
                userId: "u_new",
                body: { id: "m1", metadata: "meta-new", daemonState: "state-new", dataEncryptionKey: null },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            error: "machine_id_conflict",
            message: expect.any(String),
        });

        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(txMachineUpdate).not.toHaveBeenCalled();
    });

    it("returns the existing machine when create races (P2002) and the machine id belongs to the same account", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        const reply = createReplyStub();

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
        dbMachineFindFirst.mockResolvedValueOnce(null as any);
        dbMachineFindFirst.mockResolvedValueOnce(existingSameAccount as any);
        txMachineCreate.mockRejectedValueOnce(Object.assign(new Error("P2002"), { code: "P2002" }));

        const response = await handler(
            { userId: "u_new", body: { id: "m1", metadata: "meta-new", daemonState: undefined, dataEncryptionKey: null } },
            reply,
        );

        expect(reply.code).not.toHaveBeenCalledWith(409);
        expect((response as any)?.machine?.id).toBe("m1");
    });
});

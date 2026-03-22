import { describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

// Keep change tracking/events out of scope for this behavior test.
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 0) }));
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
    dataEncryptionKey: null,
    seq: 1,
    active: true,
    lastActiveAt: new Date(1),
    revokedAt: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
};

const dbMocks = createDbMocks({
    machine: ["findFirst", "findUnique"],
} as const);

function hasStringCode(error: unknown): error is { code: string } {
    if (!error || typeof error !== "object") {
        return false;
    }
    return typeof (error as { code?: unknown }).code === "string";
}

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: (err: unknown, code: string) =>
        hasStringCode(err) && err.code === code,
}));

const inTx = vi.fn(async () => {
    throw Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), {
        code: "P2028",
    });
});

vi.mock("@/storage/inTx", () => ({
    afterTx: vi.fn(),
    inTx,
}));

describe("machinesRoutes (update existing machine, tx busy)", () => {
    it("returns the existing machine row when the update transaction cannot start (best-effort)", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        dbMocks.reset();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
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
                    metadata: "meta-new",
                    daemonState: undefined,
                },
            },
        );

        expect(dbMocks.db.machine.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "u1",
                id: "m1",
            },
        });
        expect(inTx).toHaveBeenCalledTimes(1);
        expect(reply.send).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({
                    id: "m1",
                    metadata: "meta-old",
                }),
            }),
        );
    });

    it("does not silently succeed when a dataEncryptionKey update is skipped by transaction contention", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        dbMocks.reset();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines",
            registerRoutes(app) {
                machinesRoutes(app as any);
            },
        });

        await expect(
            route.handler(
                {
                    userId: "u1",
                    body: {
                        id: "m1",
                        metadata: "meta-old",
                        daemonState: undefined,
                        dataEncryptionKey: "AAECAw==",
                    },
                },
                route.createReply(),
            ),
        ).rejects.toMatchObject({ code: "P2028" });
    });
});

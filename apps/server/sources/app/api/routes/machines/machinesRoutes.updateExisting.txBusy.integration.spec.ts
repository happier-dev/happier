import { describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";

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

const dbMachineFindFirst = vi.fn(async () => existingMachine);
vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: dbMachineFindFirst,
            findUnique: vi.fn(async () => null),
        },
    },
    isPrismaErrorCode: (err: unknown, code: string) =>
        typeof err === "object" && err !== null && "code" in err && (err as any).code === code,
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
                    metadata: "meta-new",
                    daemonState: undefined,
                },
            },
            reply,
        );

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
});


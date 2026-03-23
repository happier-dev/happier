import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 123) }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { setMachineActive: vi.fn() } }));

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
    revokedAt: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
};

const dbMocks = createDbMocks({
    machine: ["findFirst", "findUnique"],
    account: ["findUnique", "updateMany"],
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

async function createMachinesRoute() {
    const { machinesRoutes } = await import("./machinesRoutes");
    return createRouteTestBuilder({
        method: "POST",
        path: "/v1/machines",
        registerRoutes(app) {
            machinesRoutes(app as any);
        },
    });
}

describe("machinesRoutes (contentPublicKey guard)", () => {
    const resetContentPublicKeyGuardEnv = createEnvReset();

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        resetContentPublicKeyGuardEnv();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        dbMocks.db.account.findUnique.mockResolvedValue({ contentPublicKey: new Uint8Array(32).fill(7) });
        dbMocks.db.account.updateMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.machine.create.mockImplementation(async () => {
            throw new Error("unexpected create");
        });
        txDbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        txDbMocks.db.machine.update.mockImplementation(async (args: any) => ({
            ...existingMachine,
            ...args.data,
            lastActiveAt: new Date(),
            updatedAt: new Date(),
        }));
    });

    it("allows machine writes when dataEncryptionKey is provided but contentPublicKey is missing (backward compatible)", async () => {
        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-old",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(txDbMocks.db.machine.update).toHaveBeenCalled();
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({
                    id: "m1",
                    dataEncryptionKey: "AAECAw==",
                }),
            }),
        );
    });

    it("returns 400 when contentPublicKey does not match the account contentPublicKey", async () => {
        const route = await createMachinesRoute();
        const mismatchKey = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-old",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
                contentPublicKey: mismatchKey,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_mismatch" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("returns 400 when strict mode is enabled and contentPublicKey is missing", async () => {
        resetContentPublicKeyGuardEnv({ HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: "1" });

        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-old",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_required" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("does not set account contentPublicKey when missing and no signature is provided (compat)", async () => {
        dbMocks.db.account.findUnique.mockResolvedValueOnce({ contentPublicKey: null });
        const route = await createMachinesRoute();
        const contentPublicKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-old",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
                contentPublicKey,
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(dbMocks.db.account.updateMany).not.toHaveBeenCalled();
        expect(txDbMocks.db.machine.update).toHaveBeenCalledTimes(1);
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1" }),
            }),
        );
    });

    it("sets account contentPublicKey when missing and a valid signature is provided", async () => {
        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKey = Buffer.from(contentKey.publicKey).toString("base64");
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const sig = tweetnacl.sign.detached(binding, signing.secretKey);
        const contentPublicKeySig = Buffer.from(sig).toString("base64");

        dbMocks.db.account.findUnique.mockResolvedValueOnce({
            contentPublicKey: null,
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
        });
        dbMocks.db.account.updateMany.mockResolvedValueOnce({ count: 1 });

        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-old",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
                contentPublicKey,
                contentPublicKeySig,
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(dbMocks.db.account.updateMany).toHaveBeenCalledTimes(1);
        expect(txDbMocks.db.machine.update).toHaveBeenCalledTimes(1);
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1" }),
            }),
        );
    });
});

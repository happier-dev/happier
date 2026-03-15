import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";
import tweetnacl from "tweetnacl";

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

const dbMachineFindFirst = vi.fn(async () => existingMachine);
const dbAccountFindUnique = vi.fn(async (): Promise<{ contentPublicKey: Uint8Array | null; publicKey?: string } | null> => ({
    contentPublicKey: new Uint8Array(32).fill(7),
}));
const dbAccountUpdateMany = vi.fn(async () => ({ count: 0 }));

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: dbMachineFindFirst,
            findUnique: vi.fn(async () => null),
        },
        account: {
            findUnique: dbAccountFindUnique,
            updateMany: dbAccountUpdateMany,
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
        create: vi.fn(async () => {
            throw new Error("unexpected create");
        }),
        findFirst: vi.fn(async () => existingMachine),
        update: txMachineUpdate,
    },
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

describe("machinesRoutes (contentPublicKey guard)", () => {
    beforeEach(() => {
        txMachineUpdate.mockClear();
        dbAccountFindUnique.mockClear();
        dbAccountUpdateMany.mockClear();
    });

    it("allows machine writes when dataEncryptionKey is provided but contentPublicKey is missing (backward compatible)", async () => {
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
                    dataEncryptionKey: "AAECAw==",
                },
            },
            reply,
        );

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(txMachineUpdate).toHaveBeenCalled();
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
        const { machinesRoutes } = await import("./machinesRoutes");

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = createReplyStub();
        const mismatchKey = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
        const response = await handler(
            {
                userId: "u1",
                body: {
                    id: "m1",
                    metadata: "meta-old",
                    daemonState: undefined,
                    dataEncryptionKey: "AAECAw==",
                    contentPublicKey: mismatchKey,
                },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_mismatch" });
        expect(txMachineUpdate).not.toHaveBeenCalled();
    });

    it("returns 400 when strict mode is enabled and contentPublicKey is missing", async () => {
        const prev = process.env.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK;
        process.env.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK = "1";

        try {
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
                        dataEncryptionKey: "AAECAw==",
                    },
                },
                reply,
            );

            expect(reply.code).toHaveBeenCalledWith(400);
            expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_required" });
            expect(txMachineUpdate).not.toHaveBeenCalled();
        } finally {
            if (prev === undefined) delete process.env.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK;
            else process.env.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK = prev;
        }
    });

    it("does not set account contentPublicKey when missing and no signature is provided (compat)", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        dbAccountFindUnique.mockResolvedValueOnce({ contentPublicKey: null });

        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/machines");
        expect(typeof handler).toBe("function");

        const reply = createReplyStub();
        const contentPublicKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
        const response = await handler(
            {
                userId: "u1",
                body: {
                    id: "m1",
                    metadata: "meta-old",
                    daemonState: undefined,
                    dataEncryptionKey: "AAECAw==",
                    contentPublicKey,
                },
            },
            reply,
        );

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(dbAccountUpdateMany).not.toHaveBeenCalled();
        expect(txMachineUpdate).toHaveBeenCalledTimes(1);
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1" }),
            }),
        );
    });

    it("sets account contentPublicKey when missing and a valid signature is provided", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKey = Buffer.from(contentKey.publicKey).toString("base64");
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const sig = tweetnacl.sign.detached(binding, signing.secretKey);
        const contentPublicKeySig = Buffer.from(sig).toString("base64");

        dbAccountFindUnique.mockResolvedValueOnce({
            contentPublicKey: null,
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
        });
        dbAccountUpdateMany.mockResolvedValueOnce({ count: 1 });

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
                    dataEncryptionKey: "AAECAw==",
                    contentPublicKey,
                    contentPublicKeySig,
                },
            },
            reply,
        );

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(dbAccountUpdateMany).toHaveBeenCalledTimes(1);
        expect(txMachineUpdate).toHaveBeenCalledTimes(1);
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1" }),
            }),
        );
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 123) }));
vi.mock("@/app/changes/markAccountChangedAfterCommit", () => ({ markAccountChangedAfterCommit: vi.fn(async () => 123) }));
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
    machine: ["findFirst", "findMany", "findUnique"],
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

async function createMachinesReadRoute(
    path: "/v1/machines" | "/v1/machines/:id",
) {
    const { machinesRoutes } = await import("./machinesRoutes");
    return createRouteTestBuilder({
        method: "GET",
        path,
        registerRoutes(app) {
            machinesRoutes(app as any);
        },
    });
}

const currentStoredContentCompatibility = {
    supportsCurrentProtocol: true,
    outcome: "accepted",
} as const;

const legacyStoredContentCompatibility = {
    supportsCurrentProtocol: false,
    outcome: "legacy-missing",
} as const;

const accountStoredContentUpgradeRequired = {
    error: "client-upgrade-required",
    requirement: {
        v: 1,
        kind: "account-stored-content",
        minimumProtocolVersion: 1,
    },
} as const;

describe("machinesRoutes (contentPublicKey guard)", () => {
    const resetContentPublicKeyGuardEnv = createEnvReset();

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        resetContentPublicKeyGuardEnv();
        dbMocks.db.machine.findFirst.mockResolvedValue(existingMachine);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: new Uint8Array(32).fill(7),
            publicKey: "account-signing-key",
            encryptionMode: "e2ee",
        });
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

    it("rejects encrypted machine content for a keyless plaintext account before mutation", async () => {
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: null,
            encryptionMode: "plain",
        });
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "encrypted-metadata",
                daemonState: undefined,
                dataEncryptionKey: "AAECAw==",
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({
            error: "invalid-params",
            reason: "machine_storage_mode_mismatch",
        });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("keeps an existing legacy E2EE Machine writable after the Account mode becomes plain", async () => {
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: null,
            encryptionMode: "plain",
        });
        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: "meta-new",
                daemonState: "state-new",
                dataEncryptionKey: Buffer.from(existingMachine.dataEncryptionKey).toString("base64"),
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(response).toEqual({
            machine: expect.objectContaining({
                id: "m1",
                metadata: "meta-new",
                daemonState: "state-new",
            }),
        });
        expect(txDbMocks.db.machine.update).toHaveBeenCalledTimes(1);
    });

    it("rejects an existing-row update when the transactional reread has changed to the plain marker", async () => {
        const plainCurrent = {
            ...existingMachine,
            metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
            daemonState: encodePlainMachineStoredContent({ status: "running" }),
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        txDbMocks.db.machine.findFirst.mockResolvedValue(plainCurrent);

        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: currentStoredContentCompatibility,
            body: {
                id: "m1",
                metadata: "encrypted-metadata-new",
                daemonState: "encrypted-state-new",
                dataEncryptionKey: "AAECAw==",
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({
            error: "invalid-params",
            reason: "machine_storage_mode_mismatch",
        });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("rejects the canonical plain Machine marker for an E2EE account before mutation", async () => {
        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m1",
                metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
                daemonState: undefined,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({
            error: "invalid-params",
            reason: "machine_storage_mode_mismatch",
        });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("registers canonical plain Machine content without an account content key", async () => {
        resetContentPublicKeyGuardEnv({
            HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: "1",
        });
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: null,
            encryptionMode: "plain",
        });
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        const metadata = encodePlainMachineStoredContent({ host: "machine-a" });
        const daemonState = encodePlainMachineStoredContent({
            status: "running",
            pid: 42,
        });
        const createdMachine = {
            ...existingMachine,
            metadata,
            daemonState,
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        txDbMocks.db.machine.create.mockResolvedValue(createdMachine);

        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: currentStoredContentCompatibility,
            body: {
                id: "m1",
                metadata,
                daemonState,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(txDbMocks.db.machine.create).toHaveBeenCalledTimes(1);
        expect(response).toEqual({
            machine: expect.objectContaining({
                id: "m1",
                metadata,
                daemonState,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            }),
        });
    });

    it("requires current caller support before creating a canonical plain Machine", async () => {
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: null,
            encryptionMode: "plain",
        });
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        const route = await createMachinesRoute();
        const { response, reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: legacyStoredContentCompatibility,
            body: {
                id: "m1",
                metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
                daemonState: encodePlainMachineStoredContent({ status: "running" }),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(reply.send).toHaveBeenCalledWith(
            accountStoredContentUpgradeRequired,
        );
        expect(txDbMocks.db.machine.create).not.toHaveBeenCalled();
    });

    it("requires current caller support before returning an idempotent existing plain Machine", async () => {
        const metadata = encodePlainMachineStoredContent({ host: "machine-a" });
        const daemonState = encodePlainMachineStoredContent({ status: "running" });
        const plainMachine = {
            ...existingMachine,
            metadata,
            daemonState,
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: null,
            encryptionMode: "plain",
        });
        dbMocks.db.machine.findFirst.mockResolvedValue(plainMachine);

        const route = await createMachinesRoute();
        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: legacyStoredContentCompatibility,
            body: {
                id: "m1",
                metadata,
                daemonState,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(reply.send).toHaveBeenCalledWith(
            accountStoredContentUpgradeRequired,
        );
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("requires current caller support before listing any marked Machine row", async () => {
        const plainMachine = {
            ...existingMachine,
            metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
            daemonState: encodePlainMachineStoredContent({ status: "running" }),
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        dbMocks.db.machine.findMany.mockResolvedValue([
            existingMachine,
            plainMachine,
        ]);
        const route = await createMachinesReadRoute("/v1/machines");
        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: legacyStoredContentCompatibility,
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(reply.send).toHaveBeenCalledWith(
            accountStoredContentUpgradeRequired,
        );
    });

    it("keeps the legacy full machine response for an ordinary authenticated session", async () => {
        dbMocks.db.machine.findMany.mockResolvedValue([existingMachine]);
        const route = await createMachinesReadRoute("/v1/machines");
        const { response } = await route.invoke({
            userId: "u1",
            authTokenKind: "account",
            accountStoredContentCompatibility: currentStoredContentCompatibility,
        });

        expect(response).toEqual([{
            id: "m1",
            metadata: "meta-old",
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: "AAkJCQ==",
            installationId: null,
            installationPublicKey: null,
            contentPublicKeyFingerprint: null,
            operationProtocolCapabilities: null,
            operationProtocolCapabilitiesRevision: null,
            replacedByMachineId: null,
            replacedAt: null,
            replacementReason: null,
            replacementSource: null,
            replacementActorUserId: null,
            seq: 1,
            active: true,
            activeAt: 1,
            revokedAt: null,
            createdAt: 1,
            updatedAt: 1,
        }]);
    });

    it("requires current caller support before returning marked Machine detail", async () => {
        dbMocks.db.machine.findFirst.mockResolvedValue({
            ...existingMachine,
            metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
            daemonState: encodePlainMachineStoredContent({ status: "running" }),
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        });
        const route = await createMachinesReadRoute("/v1/machines/:id");
        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: legacyStoredContentCompatibility,
            params: { id: "m1" },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(reply.send).toHaveBeenCalledWith(
            accountStoredContentUpgradeRequired,
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
        dbMocks.db.account.findUnique.mockResolvedValueOnce({
            contentPublicKey: null,
            publicKey: "account-signing-key",
            encryptionMode: "e2ee",
        });
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

        const accountWithoutContentKey = {
            contentPublicKey: null,
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
        };
        dbMocks.db.account.findUnique
            .mockResolvedValueOnce(accountWithoutContentKey)
            .mockResolvedValueOnce(accountWithoutContentKey);
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

    it("fills a missing signature for the exact same account content key after validating proof", async () => {
        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKey = Buffer.from(contentKey.publicKey).toString("base64");
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const sig = tweetnacl.sign.detached(binding, signing.secretKey);
        const contentPublicKeySig = Buffer.from(sig).toString("base64");
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: new Uint8Array(contentKey.publicKey),
            contentPublicKeySig: null,
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
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
        expect(dbMocks.db.account.updateMany).toHaveBeenCalledWith({
            where: {
                id: "u1",
                contentPublicKey: new Uint8Array(contentKey.publicKey),
                contentPublicKeySig: null,
            },
            data: {
                contentPublicKeySig: new Uint8Array(sig),
            },
        });
        expect(txDbMocks.db.machine.update).toHaveBeenCalledTimes(1);
        expect(response).toEqual(
            expect.objectContaining({
                machine: expect.objectContaining({ id: "m1" }),
            }),
        );
    });
});

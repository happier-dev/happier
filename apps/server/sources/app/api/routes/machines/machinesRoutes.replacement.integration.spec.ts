import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const markAccountChanged = vi.fn(async (_tx: unknown, params: { entityId: string }) => params.entityId === "m1" ? 122 : 123);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/changes/markAccountChangedAfterCommit", () => ({ markAccountChangedAfterCommit: vi.fn(async () => 123) }));

const emitUpdate = vi.fn();
const getConnections = vi.fn(() => new Set());
const buildNewMachineUpdate = vi.fn((_machine: unknown, seq: number, id: string) => ({
    id,
    seq,
    body: { t: "new-machine" },
}));
const buildUpdateMachineUpdate = vi.fn((machineId: string, seq: number, id: string, _metadata?: unknown, _daemonState?: unknown, extra?: unknown) => ({
    id,
    seq,
    body: { t: "update-machine", machineId, ...(extra && typeof extra === "object" ? extra : {}) },
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, getConnections },
    buildNewMachineUpdate,
    buildUpdateMachineUpdate,
}));

const invalidateMachine = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { invalidateMachine } }));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));

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

const dbMocks = createDbMocks({
    account: ["findUnique", "updateMany"],
    machine: ["findFirst", "findMany", "findUnique"],
} as const);
const txDbMocks = createDbMocks({
    accessKey: ["deleteMany"],
    machine: ["create", "findFirst", "update", "updateMany"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
    isPrismaErrorCode: (error: unknown, code: string) =>
        typeof error === "object" && error !== null && "code" in error && error.code === code,
}));

const harness = createInTxHarness(() => ({
    accessKey: txDbMocks.db.accessKey,
    machine: txDbMocks.db.machine,
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: harness.afterTx,
    inTx: harness.inTx,
}));

const contentPublicKeyFingerprint = `content-public-key-sha256:${"a".repeat(64)}`;

const baseMachine = {
    id: "m1",
    accountId: "u1",
    metadata: "old-meta",
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    dataEncryptionKey: null,
    seq: 1,
    active: false,
    lastActiveAt: new Date(1),
    revokedAt: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    installationId: "install-1",
    installationPublicKey: null,
    contentPublicKeyFingerprint,
    replacedByMachineId: null,
    replacedAt: null,
    replacementReason: null,
    replacementSource: null,
    replacementActorUserId: null,
};

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function createProof(params: Readonly<{
    installationId: string;
    machineId: string;
    replacesMachineId?: string;
    replacementReason?: string;
    contentPublicKeyFingerprint?: string;
    accountId?: string;
}>) {
    const keyPair = tweetnacl.sign.keyPair();
    const payload = {
        version: 1,
        installationId: params.installationId,
        machineId: params.machineId,
        ...(params.replacesMachineId ? { replacesMachineId: params.replacesMachineId } : {}),
        ...(params.replacementReason ? { replacementReason: params.replacementReason } : {}),
        ...(params.contentPublicKeyFingerprint ? { contentPublicKeyFingerprint: params.contentPublicKeyFingerprint } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = tweetnacl.sign.detached(bytes, keyPair.secretKey);
    return {
        publicKey: encodeBase64Url(keyPair.publicKey),
        proof: {
            version: 1,
            algorithm: "ed25519",
            payload,
            signature: encodeBase64Url(signature),
        },
    };
}

async function createRoute(method: "POST" | "DELETE", path: string) {
    const { machinesRoutes } = await import("./machinesRoutes");
    return createRouteTestBuilder({
        method,
        path,
        registerRoutes(app) {
            machinesRoutes(app as unknown as Parameters<typeof machinesRoutes>[0]);
        },
    });
}

type MachineCreateMockArgs = Readonly<{
    data: Record<string, unknown> & {
        id?: string;
    };
}>;

type MachineUpdateMockArgs = Readonly<{
    where?: {
        accountId_id?: {
            id?: string;
            accountId?: string;
        };
    };
    data: Record<string, unknown>;
}>;

describe("machinesRoutes machine replacement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        getConnections.mockReturnValue(new Set());
        dbMocks.db.account.findUnique.mockResolvedValue({
            contentPublicKey: null,
            publicKey: "account-signing-key",
            encryptionMode: "e2ee",
        });
        dbMocks.db.account.updateMany.mockResolvedValue({ count: 0 });
        dbMocks.db.machine.findFirst.mockResolvedValue(null);
        dbMocks.db.machine.findUnique.mockResolvedValue(null);
        txDbMocks.db.accessKey.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.machine.create.mockImplementation(async (args: MachineCreateMockArgs) => ({
            ...baseMachine,
            ...args.data,
            id: args.data.id,
            seq: 0,
            lastActiveAt: new Date(10),
            createdAt: new Date(10),
            updatedAt: new Date(10),
        }));
        txDbMocks.db.machine.findFirst.mockResolvedValue(baseMachine);
        txDbMocks.db.machine.update.mockImplementation(async (args: MachineUpdateMockArgs) => ({
            ...baseMachine,
            id: args.where?.accountId_id?.id ?? baseMachine.id,
            accountId: args.where?.accountId_id?.accountId ?? baseMachine.accountId,
            ...args.data,
            updatedAt: new Date(20),
        }));
        txDbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    it("creates machines with installation identity and replacement fields serialized", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });

        const route = await createRoute("POST", "/v1/machines");
        const { response } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                installationId: "install-1",
                installationPublicKey: expect.any(Uint8Array),
                contentPublicKeyFingerprint,
            }),
        }));
        expect(response).toEqual(expect.objectContaining({
            machine: expect.objectContaining({
                id: "m2",
                installationId: "install-1",
                contentPublicKeyFingerprint,
                replacedByMachineId: null,
            }),
        }));
    });

    it("rejects malformed content public key fingerprints before machine writes", async () => {
        const route = await createRoute("POST", "/v1/machines");
        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "meta",
                dataEncryptionKey: null,
                contentPublicKeyFingerprint: "content-public-key-sha256:not-valid",
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_invalid" });
        expect(txDbMocks.db.machine.create).not.toHaveBeenCalled();
    });

    it("applies explicit automatic replacement when creating a new machine", async () => {
        const { publicKey, proof } = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });

        const route = await createRoute("POST", "/v1/machines");
        const { response } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: "new-meta",
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: publicKey,
                installationProof: proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint,
            },
        });

        expect(txDbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: "m1",
                OR: [{ replacedByMachineId: null }, { replacedByMachineId: "m2" }],
            },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacementReason: "reauth",
                replacementSource: "automatic",
                replacementActorUserId: null,
            }),
        }));
        expect(invalidateMachine).toHaveBeenCalledWith("m1");
        // Replacement is reversible. It marks the old machine unavailable but
        // preserves Automation definitions and admitted Runs so undo can make
        // the old machine usable again without a restoration journal.
        expect(removeAutomationMachineAssignmentsTx).not.toHaveBeenCalled();
        expect(response).toEqual(expect.objectContaining({
            machineReplacement: {
                status: "applied",
                replacesMachineId: "m1",
            },
        }));
    });

    it("rejects existing machine registration when the installation id matches but the installation public key differs", async () => {
        const existingProof = createProof({
            installationId: "install-1",
            machineId: "m2",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });
        const incomingProof = createProof({
            installationId: "install-1",
            machineId: "m2",
            replacesMachineId: "m1",
            replacementReason: "reauth",
            contentPublicKeyFingerprint,
            accountId: "u1",
        });
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m2",
            installationId: "install-1",
            installationPublicKey: Buffer.from(existingProof.publicKey, "base64url"),
        });
        txDbMocks.db.machine.findFirst.mockResolvedValueOnce({
            ...baseMachine,
            id: "m2",
            installationId: "install-1",
            installationPublicKey: Buffer.from(existingProof.publicKey, "base64url"),
        });

        const route = await createRoute("POST", "/v1/machines");
        const { reply } = await route.invoke({
            userId: "u1",
            body: {
                id: "m2",
                metadata: baseMachine.metadata,
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: incomingProof.publicKey,
                installationProof: incomingProof.proof,
                replacesMachineId: "m1",
                replacementReason: "reauth",
                contentPublicKeyFingerprint,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ error: "invalid-params", reason: "installation_public_key_mismatch" });
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
        expect(txDbMocks.db.machine.updateMany).not.toHaveBeenCalled();
    });

    it("exposes manual replacement and undo routes", async () => {
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({ id: "m2" });
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce(baseMachine)
            .mockResolvedValueOnce({ ...baseMachine, id: "m2", active: true, replacedByMachineId: null })
            .mockResolvedValueOnce({ ...baseMachine, replacedByMachineId: "m2", replacementSource: "manual" });

        const route = await createRoute("POST", "/v1/machines/:oldMachineId/replacement");
        const { response } = await route.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
            body: { replacementMachineId: "m2", confirmActiveOldMachine: true },
        });

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                active: false,
                replacedByMachineId: "m2",
                replacementSource: "manual",
                replacementActorUserId: "u1",
            }),
        }));
        expect(response).toEqual(expect.objectContaining({
            machine: expect.objectContaining({ replacedByMachineId: "m2" }),
        }));
        expect(removeAutomationMachineAssignmentsTx).not.toHaveBeenCalled();

        const undoRoute = await createRoute("DELETE", "/v1/machines/:oldMachineId/replacement");
        await undoRoute.invoke({
            userId: "u1",
            params: { oldMachineId: "m1" },
        });

        expect(txDbMocks.db.machine.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId_id: { accountId: "u1", id: "m1" } },
            data: expect.objectContaining({
                replacedByMachineId: null,
                replacedAt: null,
                replacementReason: null,
                replacementSource: null,
                replacementActorUserId: null,
            }),
        }));
    });

    it("does not apply manual replacement for a marked Machine when the caller is legacy", async () => {
        dbMocks.db.machine.findFirst.mockResolvedValueOnce({ id: "m2" });
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({
                ...baseMachine,
                dataEncryptionKey: new Uint8Array(
                    Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
                ),
            })
            .mockResolvedValueOnce({
                ...baseMachine,
                id: "m2",
                active: true,
            });

        const route = await createRoute("POST", "/v1/machines/:oldMachineId/replacement");
        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                outcome: "legacy-missing",
            },
            params: { oldMachineId: "m1" },
            body: { replacementMachineId: "m2", confirmActiveOldMachine: true },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("does not undo replacement for a marked Machine when the caller is legacy", async () => {
        const markedMachine = {
            ...baseMachine,
            replacedByMachineId: "m2",
            replacementSource: "manual",
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            ),
        };
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce(markedMachine)
            .mockResolvedValueOnce(markedMachine);

        const route = await createRoute("DELETE", "/v1/machines/:oldMachineId/replacement");
        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                outcome: "legacy-missing",
            },
            params: { oldMachineId: "m1" },
        });

        expect(reply.code).toHaveBeenCalledWith(426);
        expect(txDbMocks.db.machine.update).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });
});

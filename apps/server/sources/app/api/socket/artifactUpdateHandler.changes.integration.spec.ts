import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    signAccountContentKeyBindingV1,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

vi.mock("@/app/api/socket/socketCredentialCurrentness", async () => (
    await import("../testkit/socketHarness")
).createCurrentSocketCredentialModuleMock());

const emitUpdate = vi.fn();
vi.mock("@/app/events/eventRouter", async () => ({
    ...await import("@/app/events/eventPayloadBuilders"),
    eventRouter: { emitUpdate },
}));
vi.mock("@/app/events/connectionEventRouter", () => ({ eventRouter: { emitUpdate } }));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const testAccountSigningKeyPair = tweetnacl.sign.keyPair();
const testAccountContentKeyPair = tweetnacl.box.keyPair();
const testAccountContentKeySignature = signAccountContentKeyBindingV1({
    accountSigningSecretKey: testAccountSigningKeyPair.secretKey,
    contentPublicKey: testAccountContentKeyPair.publicKey,
});
const readyE2eeAccount = {
    encryptionMode: "e2ee",
    publicKey: Buffer.from(testAccountSigningKeyPair.publicKey).toString("hex"),
    contentPublicKey: new Uint8Array(testAccountContentKeyPair.publicKey),
    contentPublicKeySig: new Uint8Array(testAccountContentKeySignature),
} as const;

vi.mock("@/app/monitoring/metrics/index", () => ({
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const txDbMocks = createDbMocks({
    account: ["findUnique", "update"],
    accountChange: ["upsert"],
    artifact: ["findFirst", "findUnique", "updateMany", "create", "delete", "deleteMany"],
    artifactRevision: ["create", "findMany", "deleteMany"],
    artifactBlob: ["findMany"],
} as const);

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
        account: txDbMocks.db.account,
        accountChange: txDbMocks.db.accountChange,
        artifactRevision: txDbMocks.db.artifactRevision,
        artifactBlob: txDbMocks.db.artifactBlob,
        // The persistent boundary returns joined owner/grant facts when selected.
        artifact: { ...txDbMocks.db.artifact, findFirst: async (...args: unknown[]) => {
            const row = await txDbMocks.db.artifact.findFirst(...args);
            if (!row) return row;
            const accountId = row.accountId ?? "u1";
            return { ...row, accountId, account: row.account ?? await txDbMocks.db.account.findUnique({ where: { id: accountId } }),
                accountGrants: row.accountGrants ?? [], teamGrants: row.teamGrants ?? [], groupGrants: row.groupGrants ?? [] };
        } },
    }));

    return { afterTx, inTx };
});

const dbAccountFindUnique = txDbMocks.db.account.findUnique;
const dbArtifactFindUnique = txDbMocks.db.artifact.findUnique;
const dbArtifactFindFirst = txDbMocks.db.artifact.findFirst;
installDbModuleMock(() => ({
    db: txDbMocks.db,
}));

describe("artifactUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        vi.clearAllMocks();
        txDbMocks.reset();

        dbArtifactFindUnique.mockResolvedValue(null);
        dbAccountFindUnique.mockResolvedValue(readyE2eeAccount);
        txDbMocks.db.account.findUnique.mockResolvedValue(readyE2eeAccount);
        txDbMocks.db.account.update.mockResolvedValue({ seq: 555 });
        txDbMocks.db.accountChange.upsert.mockResolvedValue({});
        // The persistence boundary includes retained revisions and exact blob custody.
        txDbMocks.db.artifactRevision.create.mockResolvedValue({});
        txDbMocks.db.artifactRevision.findMany.mockResolvedValue([]);
        txDbMocks.db.artifactRevision.deleteMany.mockResolvedValue({ count: 0 });
        txDbMocks.db.artifactBlob.findMany.mockResolvedValue([]);
    });

    const currentSocket = () => createFakeSocket({ data: {} });

    it("reads a marked Artifact without a component-version declaration", async () => {
        dbAccountFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        dbArtifactFindFirst.mockResolvedValue({
            id: "plain-read",
            accountId: "u1",
            header: Buffer.from(encodePlainArtifactStoredContent({ title: "plain" }), "base64"),
            headerVersion: 1,
            body: Buffer.from(encodePlainArtifactStoredContent({ body: "plain" }), "base64"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
            seq: 4,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const legacySocket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", legacySocket as any);
        const callback = vi.fn();

        await getSocketHandler(legacySocket, "artifact-read")(
            { artifactId: "plain-read" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "success" }));

        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const currentCallback = vi.fn();
        await getSocketHandler(socket, "artifact-read")(
            { artifactId: "plain-read" },
            currentCallback,
        );
        expect(currentCallback).toHaveBeenCalledWith({
            result: "success",
            artifact: expect.objectContaining({
                id: "plain-read",
                header: encodePlainArtifactStoredContent({ title: "plain" }),
                body: encodePlainArtifactStoredContent({ body: "plain" }),
            }),
        });
    });

    it("fails closed when persisted plain Artifact content disagrees with the Account mode", async () => {
        const header = encodePlainArtifactStoredContent({ title: "must-not-leak" });
        const body = encodePlainArtifactStoredContent({ body: "must-not-leak" });
        dbArtifactFindFirst.mockResolvedValue({
            id: "mode-mismatch",
            accountId: "u1",
            header: Buffer.from(header, "base64"),
            headerVersion: 1,
            body: Buffer.from(body, "base64"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
            seq: 4,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();

        await getSocketHandler(socket, "artifact-read")(
            { artifactId: "mode-mismatch" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            result: "error",
            message: "Internal error",
        });
        expect(callback).not.toHaveBeenCalledWith(
            expect.objectContaining({ result: "success" }),
        );
        expect(JSON.stringify(callback.mock.calls)).not.toContain(header);
        expect(JSON.stringify(callback.mock.calls)).not.toContain(body);
        expect(JSON.stringify(callback.mock.calls)).not.toContain("must-not-leak");
    });

    it("marks artifact update and emits update using returned cursor", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "a1",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 2,
            dataEncryptionKey: Buffer.from("k"),
            seq: 7,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txDbMocks.db.artifact.updateMany.mockResolvedValue({ count: 1 });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-update");

        const callback = vi.fn();
        await handler(
            {
                artifactId: "a1",
                header: { data: "aGVsbG8=", expectedVersion: 1 },
                body: { data: "d29ybGQ=", expectedVersion: 2 },
            },
            callback,
        );

        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a1", cursor: 555 }),
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", payload: expect.objectContaining({
            seq: 555, body: { t: "update-artifact", artifactId: "a1",
                header: { value: "aGVsbG8=", version: 2 }, body: { value: "d29ybGQ=", version: 3 },
                provenance: null, provenanceDataEncryptionKey: null },
        }) }));
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                header: { version: 2, data: "aGVsbG8=" },
                body: { version: 3, data: "d29ybGQ=" },
            }),
        );
    });

    it("updates a marked Artifact without a component-version declaration", async () => {
        txDbMocks.db.account.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        const currentHeader = Buffer.from(
            encodePlainArtifactStoredContent({ title: "old" }),
            "base64",
        );
        const nextHeader = encodePlainArtifactStoredContent({ title: "new" });
        const artifact = {
            id: "plain-update",
            accountId: "u1",
            header: currentHeader,
            headerVersion: 1,
            body: Buffer.from(
                encodePlainArtifactStoredContent({ body: "plain" }),
                "base64",
            ),
            bodyVersion: 1,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            seq: 7,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        };
        txDbMocks.db.artifact.findFirst.mockResolvedValue(artifact);
        txDbMocks.db.artifact.updateMany.mockResolvedValue({ count: 1 });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const legacySocket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", legacySocket as any);
        const legacyCallback = vi.fn();
        await getSocketHandler(legacySocket, "artifact-update")({
            artifactId: artifact.id,
            header: { data: nextHeader, expectedVersion: 1 },
        }, legacyCallback);

        expect(legacyCallback).toHaveBeenCalledWith(expect.objectContaining({ result: "success" }));
        txDbMocks.db.artifact.updateMany.mockClear();

        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();
        await getSocketHandler(socket, "artifact-update")({
            artifactId: artifact.id,
            header: { data: nextHeader, expectedVersion: 1 },
        }, callback);

        expect(txDbMocks.db.artifact.updateMany).toHaveBeenCalledOnce();
        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ entityId: "plain-update", cursor: 555 }),
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            seq: 555, body: expect.objectContaining({ t: "update-artifact", artifactId: "plain-update" }),
        }) }));
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            header: { version: 2, data: nextHeader },
        });
    });

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        txDbMocks.db.artifact.findUnique.mockResolvedValue(null);
        txDbMocks.db.artifact.create.mockResolvedValue({
            id: "a2",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from("k"),
            seq: 0,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-create");

        const callback = vi.fn();
        await handler({ id: "a2", header: "aGVhZA==", body: "Ym9keQ==", dataEncryptionKey: "a2V5" }, callback);

        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a2", cursor: 555 }),
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            seq: 555, body: expect.objectContaining({ t: "new-artifact", artifactId: "a2" }),
        }) }));
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                artifact: expect.objectContaining({ id: "a2", headerVersion: 1, bodyVersion: 1 }),
            }),
        );
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "a3",
            dataEncryptionKey: Buffer.from("key"),
            headerVersion: 1,
            bodyVersion: 1,
            deletedAt: null,
            blobs: [],
        });
        txDbMocks.db.artifact.updateMany.mockResolvedValue({ count: 1 });
        txDbMocks.db.artifact.deleteMany.mockResolvedValue({ count: 1 });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-delete");

        const callback = vi.fn();
        await handler({ artifactId: "a3" }, callback);

        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a3", cursor: 555 }),
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            seq: 555, body: { t: "delete-artifact", artifactId: "a3" },
        }) }));
        expect(callback).toHaveBeenCalledWith({ result: "success" });
    });

    it("preserves a plaintext-marked Artifact when socket delete finds an E2EE Account", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "mode-mismatch-delete",
            dataEncryptionKey: privacyKit.decodeBase64(
                ARTIFACT_PLAIN_DATA_KEY_MARKER,
            ),
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();
        await getSocketHandler(socket, "artifact-delete")(
            { artifactId: "mode-mismatch-delete" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            result: "error",
            message: "Internal error",
        });
        expect(txDbMocks.db.artifact.delete).not.toHaveBeenCalled();
        expect(txDbMocks.db.accountChange.upsert).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("does not disclose a classified plugin UI archive through the generic socket read", async () => {
        dbArtifactFindFirst.mockImplementation(async (input: Readonly<{
            where: Readonly<{
                pluginUiArtifact?: Readonly<{ is: null }>;
                packageAssetRelease?: Readonly<{ is: null }>;
            }>;
        }>) => (
            input.where.pluginUiArtifact?.is === null
                && input.where.packageAssetRelease?.is === null
                ? null
                : {
                    id: "plugin-ui-archive",
                    accountId: "u1",
                    header: Buffer.from("header"),
                    headerVersion: 1,
                    body: Buffer.from("body"),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from("key"),
                    seq: 4,
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                }
        ));

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();

        await getSocketHandler(socket, "artifact-read")(
            { artifactId: "plugin-ui-archive" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            result: "error",
            message: "Artifact not found",
        });
        expect(callback).not.toHaveBeenCalledWith(
            expect.objectContaining({ result: "success" }),
        );
    });

    it("does not disclose a classified package-asset archive through the generic socket read", async () => {
        dbArtifactFindFirst.mockImplementation(async (input: Readonly<{
            where: Readonly<{ packageAssetRelease?: Readonly<{ is: null }> }>;
        }>) => (
            input.where.packageAssetRelease?.is === null
                ? null
                : {
                    id: "plugin-package-archive",
                    accountId: "u1",
                    header: Buffer.from("header"),
                    headerVersion: 1,
                    body: Buffer.from("body"),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from("key"),
                    seq: 4,
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                }
        ));

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();

        await getSocketHandler(socket, "artifact-read")(
            { artifactId: "plugin-package-archive" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            result: "error",
            message: "Artifact not found",
        });
        expect(callback).not.toHaveBeenCalledWith(
            expect.objectContaining({ result: "success" }),
        );
    });
});

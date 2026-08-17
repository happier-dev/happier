import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const emitUpdate = vi.fn();
const buildNewArtifactUpdate = vi.fn((_artifact: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-artifact" },
}));
const buildUpdateArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-artifact" },
}));
const buildDeleteArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "delete-artifact" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 555);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const testAccountSigningKeyPair = tweetnacl.sign.keyPair();
const testAccountContentKeyPair = tweetnacl.box.keyPair();
const testAccountContentKeySignature = tweetnacl.sign.detached(
    Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(testAccountContentKeyPair.publicKey),
    ]),
    testAccountSigningKeyPair.secretKey,
);
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
    account: ["findUnique"],
    artifact: ["findFirst", "findUnique", "updateMany", "create", "delete"],
} as const);

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
        account: txDbMocks.db.account,
        artifact: txDbMocks.db.artifact,
    }));

    return { afterTx, inTx };
});

const dbMocks = createDbMocks({
    artifact: ["findFirst", "findUnique"],
} as const);
const dbArtifactFindUnique = dbMocks.db.artifact.findUnique;
const dbArtifactFindFirst = dbMocks.db.artifact.findFirst;
installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("artifactUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();

        dbArtifactFindUnique.mockResolvedValue(null);
        txDbMocks.db.account.findUnique.mockResolvedValue(readyE2eeAccount);
    });

    const currentSocket = () => createFakeSocket({
        data: {
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                outcome: "accepted",
                declaration: null,
                upgradeRequired: null,
            },
        },
    });

    const upgradeRequired = {
        error: "client-upgrade-required",
        requirement: {
            v: 1,
            kind: "account-stored-content",
            minimumProtocolVersion:
                ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
        },
    };

    it("requires current stored-content support before reading a marked artifact", async () => {
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

        expect(callback).toHaveBeenCalledWith(upgradeRequired);
        expect(callback).not.toHaveBeenCalledWith(
            expect.objectContaining({ result: "success" }),
        );

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

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a1" }),
        );
        expect(buildUpdateArtifactUpdate).toHaveBeenCalledWith(
            "a1",
            555,
            expect.any(String),
            { value: "aGVsbG8=", version: 2 },
            { value: "d29ybGQ=", version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                header: { version: 2, data: "aGVsbG8=" },
                body: { version: 3, data: "d29ybGQ=" },
            }),
        );
    });

    it("requires current stored-content support for a marked update, then updates once for a current socket", async () => {
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

        expect(legacyCallback).toHaveBeenCalledWith(upgradeRequired);
        expect(txDbMocks.db.artifact.updateMany).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();

        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();
        await getSocketHandler(socket, "artifact-update")({
            artifactId: artifact.id,
            header: { data: nextHeader, expectedVersion: 1 },
        }, callback);

        expect(txDbMocks.db.artifact.updateMany).toHaveBeenCalledOnce();
        expect(markAccountChanged).toHaveBeenCalledOnce();
        expect(emitUpdate).toHaveBeenCalledOnce();
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

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a2" }),
        );
        expect(buildNewArtifactUpdate).toHaveBeenCalledWith(expect.anything(), 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                artifact: expect.objectContaining({ id: "a2", headerVersion: 1, bodyVersion: 1 }),
            }),
        );
    });

    it("returns the typed upgrade requirement before creating a marked artifact for a legacy socket", async () => {
        txDbMocks.db.artifact.findUnique.mockResolvedValue(null);
        txDbMocks.db.account.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: null,
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();

        await getSocketHandler(socket, "artifact-create")({
            id: "plain-create",
            header: encodePlainArtifactStoredContent({ title: "plain" }),
            body: encodePlainArtifactStoredContent({ body: "plain" }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }, callback);

        expect(callback).toHaveBeenCalledWith(upgradeRequired);
        expect(txDbMocks.db.artifact.create).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();

        txDbMocks.db.artifact.create.mockResolvedValue({
            id: "plain-create",
            accountId: "u1",
            header: Buffer.from(
                encodePlainArtifactStoredContent({ title: "plain" }),
                "base64",
            ),
            headerVersion: 1,
            body: Buffer.from(
                encodePlainArtifactStoredContent({ body: "plain" }),
                "base64",
            ),
            bodyVersion: 1,
            dataEncryptionKey: privacyKit.decodeBase64(
                ARTIFACT_PLAIN_DATA_KEY_MARKER,
            ),
            seq: 0,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        const current = currentSocket();
        artifactUpdateHandler("u1", current as any);
        const currentCallback = vi.fn();
        await getSocketHandler(current, "artifact-create")({
            id: "plain-create",
            header: encodePlainArtifactStoredContent({ title: "plain" }),
            body: encodePlainArtifactStoredContent({ body: "plain" }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }, currentCallback);

        expect(txDbMocks.db.artifact.create).toHaveBeenCalledOnce();
        expect(markAccountChanged).toHaveBeenCalledOnce();
        expect(emitUpdate).toHaveBeenCalledOnce();
        expect(currentCallback).toHaveBeenCalledWith({
            result: "success",
            artifact: expect.objectContaining({ id: "plain-create" }),
        });
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "a3",
            dataEncryptionKey: Buffer.from("key"),
        });
        txDbMocks.db.artifact.delete.mockResolvedValue({ id: "a3" });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-delete");

        const callback = vi.fn();
        await handler({ artifactId: "a3" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a3" }),
        );
        expect(buildDeleteArtifactUpdate).toHaveBeenCalledWith("a3", 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ result: "success" });
    });

    it("preserves a marked artifact for a legacy delete and deletes once for a current socket", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "plain-delete",
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        });
        txDbMocks.db.artifact.delete.mockResolvedValue({ id: "plain-delete" });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");
        const legacySocket = createFakeSocket({ data: {} });
        artifactUpdateHandler("u1", legacySocket as any);
        const legacyCallback = vi.fn();
        await getSocketHandler(legacySocket, "artifact-delete")(
            { artifactId: "plain-delete" },
            legacyCallback,
        );

        expect(legacyCallback).toHaveBeenCalledWith(upgradeRequired);
        expect(txDbMocks.db.artifact.delete).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();

        const socket = currentSocket();
        artifactUpdateHandler("u1", socket as any);
        const callback = vi.fn();
        await getSocketHandler(socket, "artifact-delete")(
            { artifactId: "plain-delete" },
            callback,
        );

        expect(txDbMocks.db.artifact.delete).toHaveBeenCalledOnce();
        expect(markAccountChanged).toHaveBeenCalledOnce();
        expect(emitUpdate).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({ result: "success" });
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

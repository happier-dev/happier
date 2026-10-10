import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from 'node:crypto';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    type AccountEncryptionMigrateArtifactsDirective,
} from "@happier-dev/protocol";

import {
    matchArtifactAccountEncryptionMigrationPostStateInTx,
    migrateArtifactAccountEncryptionInTx,
} from "./artifactWriteService";

const markAccountChanged = vi.hoisted(() => vi.fn(async () => 9));
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged,
}));

describe("migrateArtifactAccountEncryptionInTx", () => {
    beforeEach(() => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST =
            "none";
        markAccountChanged.mockClear();
    });

    it('atomically replaces head and retained private blobs and rejects changed source custody before writes', async () => {
        const artifactId = '00000000-0000-4000-8000-000000000001';
        const blobId = '00000000-0000-4000-8000-000000000002';
        const uploadId = '00000000-0000-4000-8000-000000000003';
        const bytes = Uint8Array.of(0, 255, 12);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const source = { id: blobId, artifactId, storageKey: 'source-private-file', encryptionMode: 'e2ee', storedSizeBytes: 3n };
        const target = { accountId: 'account-1', row: { ...source, storageKey: `artifacts/${artifactId}/${blobId}/${uploadId}`,
            encryptionMode: 'plain', storedSizeBytes: 40n }, contentSha256: digest, sizeBytes: bytes.byteLength, candidate: true };
        const body = encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: 3, sha256: digest } });
        const row = { id: artifactId, headerVersion: 1, bodyVersion: 2, seq: 2, currentBlobId: blobId,
            header: Buffer.from([2, 1]), body: Buffer.from([2, 2]), dataEncryptionKey: Buffer.from([3, 4]),
            revisions: [{ bodyVersion: 1, body: Buffer.from([2, 3]), blobId }], blobs: [source] };
        const item = { artifactId, expectedHeaderVersion: 1, expectedBodyVersion: 2,
            expectedDataEncryptionKey: row.dataEncryptionKey.toString('base64'), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            recipientKeyEnvelopes: [], header: encodePlainArtifactStoredContent({ title: 'File' }), body,
            revisions: [{ bodyVersion: 1, expectedBody: row.revisions[0]!.body.toString('base64'), body }],
            blobs: [{ blobId, expectedContentSha256: digest, content: { t: 'plain' as const, uploadId, contentSha256: digest } }] };
        const writes: string[] = [];
        const tx = { artifact: { findMany: async () => [row], findFirst: async () => null,
            updateMany: async () => { writes.push('head'); return { count: 1 }; } },
            artifactRevision: { count: async () => 1, updateMany: async () => { writes.push('history'); return { count: 1 }; } },
            artifactBlob: { updateMany: async () => { writes.push('blob'); return { count: 1 }; } },
            uploadedFile: { findFirst: async () => ({ id: uploadId }), deleteMany: async () => ({ count: 1 }),
                upsert: async () => ({ id: 'displaced' }) },
            artifactKeyEnvelope: { deleteMany: async () => ({ count: 0 }) } } as unknown as Parameters<typeof migrateArtifactAccountEncryptionInTx>[0]['tx'];
        const options = { tx, accountId: 'account-1', fromMode: 'e2ee' as const, toMode: 'plain' as const,
            directive: { action: 'migrate' as const, items: [item] }, markChanged: async () => 1,
            preparedBlobs: new Map([[`${artifactId}/${blobId}`, { source: { ...source }, expectedContentSha256: digest, target }]]) };
        await expect(migrateArtifactAccountEncryptionInTx(options)).resolves.toEqual({ status: 'applied' });
        expect(writes).toEqual(['head', 'history', 'blob']);
        writes.length = 0;
        source.storageKey = 'concurrently-replaced-private-file';
        await expect(migrateArtifactAccountEncryptionInTx(options)).resolves.toEqual({ status: 'migration_incomplete' });
        expect(writes).toEqual([]);
    });

    it("rewrites every retained body with the head and rejects changed history before writes", async () => {
        const artifactId = "00000000-0000-4000-8000-000000000001";
        const retained = { bodyVersion: 1, body: Buffer.from([2, 9, 10]) };
        const row = { id: artifactId, headerVersion: 1, bodyVersion: 3, seq: 3,
            header: Buffer.from([2, 1, 2]), body: Buffer.from([2, 3, 4]),
            dataEncryptionKey: Buffer.from([3, 4, 5]), revisions: [retained], blobs: [] };
        const replacement = encodePlainArtifactStoredContent({ body: "Retained body" });
        const item = { artifactId, expectedHeaderVersion: 1, expectedBodyVersion: 3,
            expectedDataEncryptionKey: row.dataEncryptionKey.toString("base64"),
            header: encodePlainArtifactStoredContent({ title: "Plain" }), body: encodePlainArtifactStoredContent({ body: "Head" }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], blobs: [],
            revisions: [{ bodyVersion: 1, expectedBody: retained.body.toString("base64"), body: replacement }] };
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const updateRevision = vi.fn(async (input: { data: { body: Uint8Array } }) => {
            retained.body = Buffer.from(input.data.body);
            return { count: 1 };
        });
        // Prisma is the genuine persistence boundary; the migration and codecs remain real.
        const tx = { artifact: { findMany: vi.fn(async () => [row]), updateMany, findFirst: vi.fn(async () => null) },
            artifactRevision: { count: vi.fn(async () => row.revisions.length), updateMany: updateRevision },
            artifactKeyEnvelope: { deleteMany: vi.fn(async () => ({ count: 0 })) } } as unknown as Parameters<typeof migrateArtifactAccountEncryptionInTx>[0]["tx"];
        await expect(migrateArtifactAccountEncryptionInTx({ tx, accountId: "account-1", fromMode: "e2ee", toMode: "plain",
            directive: { action: "migrate", items: [item] }, markChanged: async () => 1 })).resolves.toEqual({ status: "applied" });
        expect(retained.body.toString("base64")).toBe(replacement);
        updateMany.mockClear();
        updateRevision.mockClear();
        for (const revisions of [[{ ...retained, body: Buffer.from([2, 11, 12]) }], [retained, { bodyVersion: 2, body: Buffer.from([2, 13, 14]) }]]) {
            row.revisions = revisions;
            await expect(migrateArtifactAccountEncryptionInTx({ tx, accountId: "account-1", fromMode: "e2ee", toMode: "plain",
                directive: { action: "migrate", items: [item] }, markChanged: async () => 1 })).resolves.toEqual({ status: "migration_incomplete" });
            expect(updateMany).not.toHaveBeenCalled();
            expect(updateRevision).not.toHaveBeenCalled();
        }
        // Persisted Account mode, not an opaque key's presence, owns admission.
        await expect(migrateArtifactAccountEncryptionInTx({ tx, accountId: "account-1", fromMode: "plain", toMode: "plain",
            directive: { action: "migrate", items: [item] }, markChanged: async () => 1 })).resolves.toEqual({ status: "invalid_content" });
        expect(updateMany).not.toHaveBeenCalled();
        expect(updateRevision).not.toHaveBeenCalled();
    });

    it("rejects an incomplete inventory before writing", async () => {
        const updateMany = vi.fn();
        await expect(migrateArtifactAccountEncryptionInTx({
            tx: {
                artifact: {
                    findMany: vi.fn(async () => [{
                        id: "00000000-0000-4000-8000-000000000001",
                        headerVersion: 1,
                        bodyVersion: 2,
                        seq: 3,
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            fromMode: "plain",
            toMode: "plain",
            directive: { action: "migrate", items: [] },
        })).resolves.toEqual({ status: "migration_incomplete" });
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("rewrites an exact Artifact pair and key marker under one version fence", async () => {
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const markChanged = vi.fn(async () => 1);
        const artifactId = "00000000-0000-4000-8000-000000000001";

        await expect(migrateArtifactAccountEncryptionInTx({
            tx: {
                artifact: {
                    findMany: vi.fn(async () => [{
                        id: artifactId,
                        headerVersion: 1,
                        bodyVersion: 2,
                        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                        header: Buffer.from(encodePlainArtifactStoredContent({ title: "Plain" }), "base64"),
                        body: Buffer.from(encodePlainArtifactStoredContent({ body: "Body" }), "base64"),
                        revisions: [], blobs: [],
                        seq: 3,
                    }]),
                    updateMany,
                    findFirst: vi.fn(async () => null),
                },
                artifactKeyEnvelope: { deleteMany: vi.fn(async () => ({ count: 0 })) },
                artifactRevision: { count: vi.fn(async () => 0) },
            } as any,
            accountId: "account-1",
            fromMode: "plain",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
                    expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    recipientKeyEnvelopes: [],
                    revisions: [], blobs: [],
                    header: encodePlainArtifactStoredContent({ title: "Plain" }),
                    body: encodePlainArtifactStoredContent({ body: "Body" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                }],
            },
            markChanged,
        })).resolves.toEqual({ status: "applied" });

        expect(updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                id: artifactId,
                headerVersion: 1,
                bodyVersion: 2,
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                provenanceDataEncryptionKey: null,
            },
            data: {
                header: Buffer.from(encodePlainArtifactStoredContent({ title: "Plain" }), "base64"),
                headerVersion: 2,
                body: Buffer.from(encodePlainArtifactStoredContent({ body: "Body" }), "base64"),
                bodyVersion: 3,
                provenance: null,
                provenanceDataEncryptionKey: null,
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                seq: 4,
                updatedAt: expect.any(Date),
            },
        });
        expect(markChanged).toHaveBeenCalledWith(artifactId);
    });

    it("projects a classified archive transition as one availability change instead of a generic Artifact change", async () => {
        const artifactId = "00000000-0000-4000-8000-000000000002";
        const updateMany = vi.fn(async () => ({ count: 1 }));

        await expect(migrateArtifactAccountEncryptionInTx({
            tx: {
                artifact: {
                    findMany: vi.fn(async () => [{
                        id: artifactId,
                        headerVersion: 1,
                        bodyVersion: 2,
                        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                        header: Buffer.from(encodePlainArtifactStoredContent({ title: "Plain" }), "base64"),
                        body: Buffer.from(encodePlainArtifactStoredContent({ body: "Body" }), "base64"),
                        revisions: [], blobs: [],
                        seq: 3,
                        pluginUiArtifact: {
                            release: {
                                accountId: "account-1",
                                pluginId: "com.acme.fixture",
                            },
                        },
                        packageAssetRelease: null,
                    }]),
                    updateMany,
                    findFirst: vi.fn(async () => null),
                },
                artifactKeyEnvelope: { deleteMany: vi.fn(async () => ({ count: 0 })) },
                artifactRevision: { count: vi.fn(async () => 0) },
            } as any,
            accountId: "account-1",
            fromMode: "plain",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
                    expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    recipientKeyEnvelopes: [],
                    revisions: [], blobs: [],
                    header: encodePlainArtifactStoredContent({ title: "Plain" }),
                    body: encodePlainArtifactStoredContent({ body: "Body" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                }],
            },
        })).resolves.toEqual({ status: "applied" });

        expect(updateMany).toHaveBeenCalledOnce();
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "account-1",
            kind: "pluginDomain",
            entityId: "pluginDomain/com.acme.fixture/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "com.acme.fixture",
            },
        });
    });

    it("projects a classified package-asset transition through the same Availability change owner", async () => {
        const artifactId = "00000000-0000-4000-8000-000000000003";
        const updateMany = vi.fn(async () => ({ count: 1 }));

        await expect(migrateArtifactAccountEncryptionInTx({
            tx: {
                artifact: {
                    findMany: vi.fn(async () => [{
                        id: artifactId,
                        headerVersion: 1,
                        bodyVersion: 2,
                        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                        header: Buffer.from(encodePlainArtifactStoredContent({ title: "Plain" }), "base64"),
                        body: Buffer.from(encodePlainArtifactStoredContent({ body: "Body" }), "base64"),
                        revisions: [], blobs: [],
                        seq: 3,
                        pluginUiArtifact: null,
                        packageAssetRelease: {
                            accountId: "account-1",
                            pluginId: "com.acme.assets",
                        },
                    }]),
                    updateMany,
                    findFirst: vi.fn(async () => null),
                },
                artifactKeyEnvelope: { deleteMany: vi.fn(async () => ({ count: 0 })) },
                artifactRevision: { count: vi.fn(async () => 0) },
            } as any,
            accountId: "account-1",
            fromMode: "plain",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
                    expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    recipientKeyEnvelopes: [],
                    revisions: [], blobs: [],
                    header: encodePlainArtifactStoredContent({ title: "Plain" }),
                    body: encodePlainArtifactStoredContent({ body: "Body" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                }],
            },
        })).resolves.toEqual({ status: "applied" });

        expect(updateMany).toHaveBeenCalledOnce();
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
            accountId: "account-1",
            kind: "pluginDomain",
            entityId: "pluginDomain/com.acme.assets/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "com.acme.assets",
            },
        });
    });

    it("matches exact opened Artifact post-state and rejects byte/version drift read-only", async () => {
        const artifactId = "00000000-0000-4000-8000-000000000001";
        const item = {
            artifactId,
            expectedHeaderVersion: 1,
            expectedBodyVersion: 2,
            expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            recipientKeyEnvelopes: [],
            revisions: [], blobs: [],
            header: encodePlainArtifactStoredContent({ title: "Plain" }),
            body: encodePlainArtifactStoredContent({ body: "Body" }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        } satisfies Extract<AccountEncryptionMigrateArtifactsDirective, { action: "migrate" }>['items'][number];
        const row = {
            id: artifactId,
            headerVersion: 2,
            bodyVersion: 3,
            header: new Uint8Array(Buffer.from(item.header, "base64")),
            body: new Uint8Array(Buffer.from(item.body, "base64")),
            dataEncryptionKey: new Uint8Array(
                Buffer.from(item.dataEncryptionKey, "base64"),
            ),
            pluginUiArtifact: null,
            revisions: [], blobs: [],
        };
        const findMany = vi.fn(async () => [row]);
        const tx = {
            artifact: {
                findMany,
                updateMany: vi.fn(),
            },
            accountChange: { upsert: vi.fn() },
        } as any;

        await expect(
            matchArtifactAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "matched" });

        findMany.mockResolvedValueOnce([{
            ...row,
            body: new TextEncoder().encode(
                JSON.stringify({ t: "plain", v: { body: "Changed" } }),
            ),
        }]);
        await expect(
            matchArtifactAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "mismatch" });

        findMany.mockResolvedValueOnce([]);
        await expect(
            matchArtifactAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "matched" });
        expect(tx.artifact.updateMany).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});

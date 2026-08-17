import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
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
                        seq: 3,
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
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
            },
            data: {
                header: expect.any(Uint8Array),
                headerVersion: 2,
                body: expect.any(Uint8Array),
                bodyVersion: 3,
                dataEncryptionKey: expect.any(Uint8Array),
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
                },
            } as any,
            accountId: "account-1",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
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
                        seq: 3,
                        pluginUiArtifact: null,
                        packageAssetRelease: {
                            accountId: "account-1",
                            pluginId: "com.acme.assets",
                        },
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    artifactId,
                    expectedHeaderVersion: 1,
                    expectedBodyVersion: 2,
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
            header: encodePlainArtifactStoredContent({ title: "Plain" }),
            body: encodePlainArtifactStoredContent({ body: "Body" }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        } as const;
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

import { describe, expect, it, vi } from "vitest";

import { artifactPluginCollectionHostReferenceAdapter } from "./artifactHostReference";

function txFixture() {
    const artifactFindFirst = vi.fn();
    const accountChangeFindUnique = vi.fn();
    return {
        tx: {
            artifact: { findFirst: artifactFindFirst },
            accountChange: { findUnique: accountChangeFindUnique },
        } as never,
        artifactFindFirst,
        accountChangeFindUnique,
    };
}

describe("Artifact host-reference adapter", () => {
    it("excludes either classified plugin Artifact from the generic Data host-reference seam", async () => {
        const classified = txFixture();
        classified.artifactFindFirst.mockImplementation(async (input: Readonly<{
            where: Readonly<{
                pluginUiArtifact?: Readonly<{ is: null }>;
                packageAssetRelease?: Readonly<{ is: null }>;
            }>;
        }>) => (
            input.where.pluginUiArtifact?.is === null
                && input.where.packageAssetRelease?.is === null
                ? null
                : { id: "artifact-1" }
        ));
        classified.accountChangeFindUnique.mockResolvedValue(null);

        await expect(artifactPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: classified.tx,
            accountId: "account-1",
            targetId: "artifact-1",
        })).resolves.toEqual({ status: "unavailable" });
        expect(classified.artifactFindFirst).toHaveBeenCalledWith({
            where: {
                id: "artifact-1",
                accountId: "account-1",
                pluginUiArtifact: { is: null },
                packageAssetRelease: { is: null },
            },
            select: { id: true },
        });
    });

    it("admits only the exact Account-owned Artifact without asking Data to read Artifact storage", async () => {
        const current = txFixture();
        current.artifactFindFirst.mockResolvedValue({ id: "artifact-1" });

        await expect(artifactPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: current.tx,
            accountId: "account-1",
            targetId: "artifact-1",
        })).resolves.toEqual({ status: "available" });
        expect(current.artifactFindFirst).toHaveBeenCalledWith({
            where: {
                id: "artifact-1",
                accountId: "account-1",
                pluginUiArtifact: { is: null },
                packageAssetRelease: { is: null },
            },
            select: { id: true },
        });
        expect(current.accountChangeFindUnique).not.toHaveBeenCalled();
    });

    it("keeps the Account-owned deletion tombstone through the canonical Artifact change record", async () => {
        const deleted = txFixture();
        deleted.artifactFindFirst.mockResolvedValue(null);
        deleted.accountChangeFindUnique.mockResolvedValue({ artifactId: null });

        await expect(artifactPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: deleted.tx,
            accountId: "account-1",
            targetId: "artifact-1",
        })).resolves.toEqual({ status: "tombstone" });
        expect(deleted.accountChangeFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-1",
                    kind: "artifact",
                    entityId: "artifact-1",
                },
            },
            select: { artifactId: true },
        });
    });

    it("fails closed for an unknown, expired, or inconsistent Artifact reference", async () => {
        const missing = txFixture();
        missing.artifactFindFirst.mockResolvedValue(null);
        missing.accountChangeFindUnique.mockResolvedValue(null);

        await expect(artifactPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: missing.tx,
            accountId: "account-1",
            targetId: "artifact-1",
        })).resolves.toEqual({ status: "unavailable" });

        const inconsistent = txFixture();
        inconsistent.artifactFindFirst.mockResolvedValue(null);
        inconsistent.accountChangeFindUnique.mockResolvedValue({ artifactId: "artifact-1" });

        await expect(artifactPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: inconsistent.tx,
            accountId: "account-1",
            targetId: "artifact-1",
        })).resolves.toEqual({ status: "unavailable" });
    });
});

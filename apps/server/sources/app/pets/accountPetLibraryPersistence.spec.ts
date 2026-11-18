import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import type { AccountPetLibraryEntryV1 } from "@happier-dev/protocol/pets/accountLibrary";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { assertAccountPetLibraryEmptyForEncryptionTransitionInTx } from "./accountPetEncryptionTransition";
import { createPrismaAccountPetLibraryPersistence } from "./accountPetLibraryPersistence";

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function createAccountContentKeyBinding() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();

    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: new Uint8Array(
            signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            }),
        ),
    };
}

describe("accountPetLibraryPersistence", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-pets-persistence-db-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountPetAsset.deleteMany(),
            () => db.accountPetPackage.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("roundtrips optional opaque bounds without adding them to package manifests", async () => {
        await db.account.create({
            data: { id: "account-1", publicKey: null, encryptionMode: "plain" },
        });
        const manifest = {
            id: "blink",
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp" as const,
        };
        const entries: AccountPetLibraryEntryV1[] = [];
        const bounds = { x: 15, y: 20, width: 130, height: 170 };
        for (const [index, opaqueBounds] of [bounds, undefined].entries()) {
            const entry: AccountPetLibraryEntryV1 = {
                accountPetId: `pet-${index}`,
                packageFormat: "codex-compatible-atlas-v1",
                manifest,
                spritesheetAssetRef: {
                    assetId: `asset-${index}`,
                    mediaType: "image/webp",
                    digest: `sha256:asset-${index}`,
                    sizeBytes: 123,
                },
                digest: `sha256:pet-${index}`,
                sizeBytes: 123,
                createdAt: 1,
                updatedAt: 1,
                origin: { kind: "manualImport" },
                ...(opaqueBounds ? { opaqueBounds } : {}),
            };
            await expect(createPrismaAccountPetLibraryPersistence().persistAccountPet({
                accountId: "account-1",
                entry,
                objectKey: `private/accounts/account-1/pets/${entry.accountPetId}/sheet.webp`,
                quotaLimits: { maxImportedPetsPerAccount: 10, maxImportedPetBytesPerAccount: 1_000 },
            })).resolves.toEqual({ ok: true });
            const row = await db.accountPetPackage.findUniqueOrThrow({ where: { id: entry.accountPetId } });
            expect(row.manifest).toEqual({ ...manifest, ...(opaqueBounds ? { opaqueBounds } : {}) });
            const read = await createPrismaAccountPetLibraryPersistence().readAccountPet("account-1", entry.accountPetId);
            expect(read?.entry).toEqual(entry);
            expect(read?.entry?.manifest).toEqual(manifest);
            entries.push(entry);
        }
        const listed = await createPrismaAccountPetLibraryPersistence().listAccountPets("account-1");
        expect(listed.map((pet) => pet.entry).sort((a, b) => (a?.accountPetId ?? "").localeCompare(b?.accountPetId ?? "")))
            .toEqual(entries);
    });

    it("rejects an asset whose account does not match the owning package account", async () => {
        await db.account.createMany({
            data: [
                {
                    id: "account-1",
                    publicKey: "account-1-public-key",
                    encryptionMode: "plain",
                },
                {
                    id: "account-2",
                    publicKey: "account-2-public-key",
                    encryptionMode: "plain",
                },
            ],
        });
        await db.accountPetPackage.create({
            data: {
                id: "pet-1",
                accountId: "account-1",
                packageFormat: "codexAtlasV1",
                contentMode: "plain",
                manifest: { id: "blink" },
                digest: "sha256:pet",
                sizeBytes: 123,
                origin: { kind: "manualImport" },
            },
        });

        let error: unknown = null;
        try {
            await db.accountPetAsset.create({
                data: {
                    id: "asset-1",
                    accountId: "account-2",
                    petPackageId: "pet-1",
                    contentMode: "plain",
                    storageKind: "privateFile",
                    objectKey: "objects/pets/asset-1",
                    byteLength: 123,
                    mediaType: "image/webp",
                    digest: "sha256:asset",
                },
            });
        } catch (nextError) {
            error = nextError;
        }

        expect(isPrismaErrorCode(error, "P2003")).toBe(true);
    });

    it("retains malformed persisted content modes for the read owner instead of compacting the row away", async () => {
        await db.account.create({
            data: {
                id: "account-1",
                publicKey: null,
                encryptionMode: "plain",
            },
        });
        await db.accountPetPackage.create({
            data: {
                id: "pet-1",
                accountId: "account-1",
                packageFormat: "codex-compatible-atlas-v1",
                contentMode: "future-package-mode",
                manifest: {
                    id: "blink",
                    displayName: "Blink",
                    description: "Happier companion pet",
                    spritesheetPath: "spritesheet.webp",
                },
                digest: "sha256:pet",
                sizeBytes: 123,
                origin: { kind: "manualImport" },
            },
        });
        await db.accountPetAsset.create({
            data: {
                id: "asset-1",
                accountId: "account-1",
                petPackageId: "pet-1",
                contentMode: "future-asset-mode",
                storageKind: "privateFile",
                objectKey: "private/accounts/account-1/pets/pet-1/sheet.webp",
                byteLength: 123,
                mediaType: "image/webp",
                digest: "sha256:asset",
            },
        });

        const persistence = createPrismaAccountPetLibraryPersistence();

        await expect(persistence.listAccountPets("account-1")).resolves.toEqual([
            expect.objectContaining({
                accountId: "account-1",
                contentMode: "future-package-mode",
                asset: expect.objectContaining({
                    contentMode: "future-asset-mode",
                }),
            }),
        ]);
    });

    it("retains malformed package and asset rows as unreadable identities instead of omitting them", async () => {
        await db.account.create({
            data: {
                id: "account-1",
                publicKey: null,
                encryptionMode: "plain",
            },
        });
        const validManifest = {
            id: "blink",
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp",
        };
        await db.accountPetPackage.createMany({
            data: [
                {
                    id: "malformed-package",
                    accountId: "account-1",
                    packageFormat: "future-package-format",
                    contentMode: "plain",
                    manifest: validManifest,
                    digest: "sha256:package-1",
                    sizeBytes: 123,
                    origin: { kind: "manualImport" },
                },
                {
                    id: "malformed-asset",
                    accountId: "account-1",
                    packageFormat: "codex-compatible-atlas-v1",
                    contentMode: "plain",
                    manifest: validManifest,
                    digest: "sha256:package-2",
                    sizeBytes: 123,
                    origin: { kind: "manualImport" },
                },
            ],
        });
        await db.accountPetAsset.createMany({
            data: [
                {
                    id: "asset-for-malformed-package",
                    accountId: "account-1",
                    petPackageId: "malformed-package",
                    contentMode: "plain",
                    storageKind: "privateFile",
                    objectKey: "private/accounts/account-1/pets/malformed-package/sheet.webp",
                    byteLength: 123,
                    mediaType: "image/webp",
                    digest: "sha256:asset-1",
                },
                {
                    id: "malformed-media-asset",
                    accountId: "account-1",
                    petPackageId: "malformed-asset",
                    contentMode: "plain",
                    storageKind: "privateFile",
                    objectKey: "private/accounts/account-1/pets/malformed-asset/sheet.bin",
                    byteLength: 123,
                    mediaType: "application/future-pet",
                    digest: "sha256:asset-2",
                },
            ],
        });

        const persistence = createPrismaAccountPetLibraryPersistence();

        await expect(persistence.listAccountPets("account-1")).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    accountPetId: "malformed-package",
                    entry: null,
                }),
                expect.objectContaining({
                    accountPetId: "malformed-asset",
                    entry: null,
                }),
            ]),
        );
    });

    it("refuses a stale plain pet create after a concurrent transition commits E2EE under the Account fence", async () => {
        const binding = createAccountContentKeyBinding();
        await db.account.create({
            data: {
                id: "account-1",
                publicKey: binding.publicKey,
                encryptionMode: "plain",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: binding.contentPublicKeySig,
            },
        });
        const transitionHasFence = deferred();
        const releaseTransition = deferred();

        const transition = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1", "exclusive");
            await expect(
                assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                    tx,
                    "account-1",
                ),
            ).resolves.toEqual({ status: "empty" });
            transitionHasFence.resolve();
            await releaseTransition.promise;
            await tx.account.update({
                where: { id: "account-1" },
                data: { encryptionMode: "e2ee" },
            });
        });
        await transitionHasFence.promise;

        let persistenceSettled = false;
        const persistence = createPrismaAccountPetLibraryPersistence()
            .persistAccountPet({
                accountId: "account-1",
                objectKey: "private/accounts/account-1/pets/pet-1/sheet.webp",
                quotaLimits: {
                    maxImportedPetsPerAccount: 10,
                    maxImportedPetBytesPerAccount: 1_000,
                },
                entry: {
                    accountPetId: "pet-1",
                    packageFormat: "codex-compatible-atlas-v1",
                    manifest: {
                        id: "blink",
                        displayName: "Blink",
                        description: "Happier companion pet",
                        spritesheetPath: "spritesheet.webp",
                    },
                    spritesheetAssetRef: {
                        assetId: "asset-1",
                        mediaType: "image/webp",
                        digest: "sha256:asset",
                        sizeBytes: 123,
                    },
                    digest: "sha256:pet",
                    sizeBytes: 123,
                    createdAt: 1,
                    updatedAt: 1,
                    origin: { kind: "manualImport" },
                },
            })
            .finally(() => {
                persistenceSettled = true;
            });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(persistenceSettled).toBe(false);

        releaseTransition.resolve();
        await transition;
        await expect(persistence).resolves.toEqual({
            ok: false,
            error: "mode-mismatch",
        });
        await expect(db.accountPetPackage.count()).resolves.toBe(0);
        await expect(db.accountPetAsset.count()).resolves.toBe(0);
    }, 30_000);
});

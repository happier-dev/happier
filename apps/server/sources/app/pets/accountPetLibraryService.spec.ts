import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLocalPrivateFilesBackend } from "@/storage/privateFiles/privateFilesLocal";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createPrismaAccountPetLibraryPersistence } from "./accountPetLibraryPersistence";
import { createAccountPetLibraryServices } from "./accountPetLibraryService";

const WEBP_BYTES = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    0x18, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
    0x00,
]);

function digest(bytes: Uint8Array): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requestFor(bytes: Uint8Array) {
    return {
        manifest: {
            id: "blink",
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp",
        },
        spritesheet: {
            mediaType: "image/webp",
            encoding: "base64",
            data: Buffer.from(bytes).toString("base64"),
            sizeBytes: bytes.byteLength,
            digest: digest(bytes),
        },
        origin: { kind: "manualImport" },
    };
}

describe("account pet library services", () => {
    const tempDirs: string[] = [];
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-pets-service-db-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountPetAsset.deleteMany(),
            () => db.accountPetPackage.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(accountId: string): Promise<void> {
        await db.account.create({
            data: {
                id: accountId,
                publicKey: `${accountId}-public-key`,
                encryptionMode: "plain",
            },
        });
    }

    it("stores spritesheet bytes privately while listing only account-owned metadata", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });

        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("expected account pet creation to succeed");
        expect(JSON.stringify(created.pet)).not.toContain("spritesheetBytes");

        const listedForOwner = await services.listAccountPetsForAccount({ accountId: "account-1" });
        expect(listedForOwner).toEqual([created.pet]);

        const listedForOtherAccount = await services.listAccountPetsForAccount({ accountId: "account-2" });
        expect(listedForOtherAccount).toEqual([]);

        const asset = await services.readAccountPetAssetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        });
        expect(asset).toEqual({
            mediaType: "image/webp",
            bytes: WEBP_BYTES,
            digest: digest(WEBP_BYTES),
            sizeBytes: WEBP_BYTES.byteLength,
        });

        await expect(privateFiles.readPrivateFile(created.pet.spritesheetAssetRef.digest)).rejects.toThrow();
    });

    it("treats stale or corrupted private asset bytes as missing", async () => {
        const stored = new Map<string, Uint8Array>();
        const services = createAccountPetLibraryServices({
            privateFiles: {
                init: async () => {},
                writePrivateFile: async (objectKey, bytes) => {
                    stored.set(objectKey, bytes);
                },
                readPrivateFile: async () => Uint8Array.from([9, 9, 9]),
                deletePrivateFile: async () => {},
            },
            createId: (() => {
                const ids = ["pet-1", "asset-1"];
                return () => ids.shift() ?? "extra-id";
            })(),
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });

        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("expected account pet creation to succeed");
        expect(stored.size).toBe(1);
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        })).resolves.toBeNull();
    });

    it("removes deleted account pet metadata and private asset bytes", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("expected account pet creation to succeed");

        const deleted = await services.deleteAccountPetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
        });

        expect(deleted).toEqual({
            ok: true,
            accountPetId: created.pet.accountPetId,
            deletedAt: expect.any(Number),
        });
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toEqual([]);
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        })).resolves.toBeNull();
    });

    it("persists account pet metadata across service recreation", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        await createAccount("account-1");
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const firstServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await firstServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("expected account pet creation to succeed");

        const secondServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        await expect(secondServices.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toEqual([created.pet]);
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-1",
                    kind: "pet",
                    entityId: created.pet.accountPetId,
                },
            },
            select: { accountPetPackageId: true, hint: true },
        })).resolves.toEqual({
            accountPetPackageId: created.pet.accountPetId,
            hint: expect.objectContaining({
                domain: "accountPet",
                action: "create",
                accountPetId: created.pet.accountPetId,
            }),
        });
    });

    it("rejects account pet creation after the configured per-account count limit", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const ids = ["pet-1", "asset-1", "pet-2", "asset-2"];
        const services = createAccountPetLibraryServices({
            privateFiles,
            maxImportedPetsPerAccount: 1,
            createId: () => ids.shift() ?? "unexpected-id",
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const first = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        const second = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });

        expect(first.ok).toBe(true);
        expect(second).toEqual({
            ok: false,
            errorCode: "quota_exceeded",
            error: "quota_exceeded",
        });
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toHaveLength(1);
    });

    it("enforces the per-account count limit when concurrent uploads race", async () => {
        await createAccount("account-1");

        const stored = new Map<string, Uint8Array>();
        let releaseWrites: (() => void) | null = null;
        const writesReady = new Promise<void>((resolve) => {
            releaseWrites = resolve;
        });
        let writeCount = 0;
        const ids = ["pet-1", "asset-1", "pet-2", "asset-2"];
        const services = createAccountPetLibraryServices({
            privateFiles: {
                init: async () => {},
                writePrivateFile: async (objectKey, bytes) => {
                    writeCount += 1;
                    if (writeCount === 2) {
                        releaseWrites?.();
                    }
                    await writesReady;
                    stored.set(objectKey, bytes);
                },
                readPrivateFile: async (objectKey) => {
                    const value = stored.get(objectKey);
                    if (!value) {
                        throw new Error(`missing private file: ${objectKey}`);
                    }
                    return value;
                },
                deletePrivateFile: async (objectKey) => {
                    stored.delete(objectKey);
                },
            },
            persistence: createPrismaAccountPetLibraryPersistence(),
            maxImportedPetsPerAccount: 1,
            createId: () => ids.shift() ?? `unexpected-id-${ids.length}`,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const [first, second] = await Promise.all([
            services.createAccountPetForAccount({
                accountId: "account-1",
                request: requestFor(WEBP_BYTES),
            }),
            services.createAccountPetForAccount({
                accountId: "account-1",
                request: requestFor(WEBP_BYTES),
            }),
        ]);

        expect([first, second]).toEqual(expect.arrayContaining([
            expect.objectContaining({ ok: true }),
            {
                ok: false,
                errorCode: "quota_exceeded",
                error: "quota_exceeded",
            },
        ]));
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toHaveLength(1);
        expect(await db.accountPetPackage.count({
            where: {
                accountId: "account-1",
                deletedAt: null,
            },
        })).toBe(1);
        expect(stored.size).toBe(1);
    });

    it("rejects account pet creation after the configured per-account byte limit", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            maxImportedPetBytesPerAccount: WEBP_BYTES.byteLength,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });

        expect(created).toEqual({
            ok: false,
            errorCode: "quota_exceeded",
            error: "quota_exceeded",
        });
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toEqual([]);
    });

    it("denies custom pet sync for e2ee accounts before writing private bytes", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "e2ee",
            storagePolicy: "optional",
            request: requestFor(WEBP_BYTES),
        });

        expect(created).toEqual({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        });
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toEqual([]);
        await expect(readdir(rootDir)).resolves.toEqual([]);
    });

    it("denies custom pet sync when server storage policy requires e2ee", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const created = await services.createAccountPetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            storagePolicy: "required_e2ee",
            request: requestFor(WEBP_BYTES),
        });

        expect(created).toEqual({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        });
        await expect(services.listAccountPetsForAccount({ accountId: "account-1" })).resolves.toEqual([]);
        await expect(readdir(rootDir)).resolves.toEqual([]);
    });
});

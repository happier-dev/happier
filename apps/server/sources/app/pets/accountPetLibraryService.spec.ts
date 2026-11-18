import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLocalPrivateFilesBackend } from "@/storage/privateFiles/privateFilesLocal";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { validateAccountPetCreateRequestV1 } from "@happier-dev/protocol/pets/accountPetCreateValidation";
import { openAccountPetSpritesheetV1, openAccountPetStoredEntryForModeV1, sealAccountPetPackageV1 } from "@happier-dev/protocol/pets/accountPetEncryptionV1";
import { PET_ATLAS_V1, PET_ATLAS_V2 } from "@happier-dev/protocol/pets/constants";

import {
    createPrismaAccountPetLibraryPersistence,
    type AccountPetLibraryPersistence,
    type PrismaAccountPetLibraryPersistenceOptions,
    type PersistedAccountPet,
} from "./accountPetLibraryPersistence";
import { createAccountPetLibraryServices } from "./accountPetLibraryService";
import { webpAtlasHeader } from "./accountPetAtlas.testkit";

const WEBP_BYTES = webpAtlasHeader(PET_ATLAS_V1);

function digest(bytes: Uint8Array): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requestFor(bytes: Uint8Array, id = "blink") {
    return {
        manifest: {
            id,
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp" as const,
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

function stableManifestJson(manifest: Record<string, unknown>): string {
    return JSON.stringify(manifest, Object.keys(manifest).sort());
}

function packageSizeBytesFor(bytes: Uint8Array): number {
    const request = requestFor(bytes);
    return Buffer.byteLength(stableManifestJson(request.manifest), "utf8") + bytes.byteLength;
}

function persistedPetWithModes(params: {
    packageContentMode: string;
    assetContentMode: string;
}): PersistedAccountPet {
    return {
        accountId: "account-1",
        accountPetId: "pet-1",
        contentMode: params.packageContentMode,
        entry: {
            accountPetId: "pet-1",
            packageFormat: "codex-compatible-atlas-v1",
            manifest: requestFor(WEBP_BYTES).manifest,
            spritesheetAssetRef: {
                assetId: "asset-1",
                mediaType: "image/webp",
                digest: digest(WEBP_BYTES),
                sizeBytes: WEBP_BYTES.byteLength,
            },
            digest: "sha256:package",
            sizeBytes: packageSizeBytesFor(WEBP_BYTES),
            createdAt: 1,
            updatedAt: 1,
            origin: { kind: "manualImport" },
        },
        asset: {
            contentMode: params.assetContentMode,
            objectKey: "private/accounts/account-1/pets/pet-1/sheet.webp",
        },
    };
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function createPrismaQuotaReadPauseHooks(): {
    hooks: NonNullable<PrismaAccountPetLibraryPersistenceOptions["hooks"]>;
    waitForFirstQuotaRead: Promise<void>;
    releaseQuotaReads(): void;
} {
    const firstQuotaRead = createDeferred<void>();
    const releaseQuotaReads = createDeferred<void>();

    return {
        waitForFirstQuotaRead: firstQuotaRead.promise,
        releaseQuotaReads() {
            releaseQuotaReads.resolve();
        },
        hooks: {
            async afterQuotaRead() {
                firstQuotaRead.resolve();
                await releaseQuotaReads.promise;
            },
        },
    };
}

function createPersistenceThatPausesFirstPersist(): {
    persistence: AccountPetLibraryPersistence;
    waitForFirstPersistStart: Promise<void>;
    releaseFirstPersist(): void;
} {
    const recordsByPetId = new Map<string, PersistedAccountPet>();
    const firstPersistStarted = createDeferred<void>();
    const releaseFirstPersist = createDeferred<void>();
    let shouldPauseFirstPersist = true;

    function listAccountPets(accountId: string): PersistedAccountPet[] {
        return Array.from(recordsByPetId.values()).filter((record) => record.accountId === accountId);
    }

    return {
        waitForFirstPersistStart: firstPersistStarted.promise,
        releaseFirstPersist() {
            releaseFirstPersist.resolve();
        },
        persistence: {
            async persistAccountPet(params) {
                const recordsForAccount = listAccountPets(params.accountId);
                if (recordsForAccount.length >= params.quotaLimits.maxImportedPetsPerAccount) {
                    return { ok: false, error: "quota-exceeded" };
                }

                const existingBytes = recordsForAccount.reduce(
                    (sum, record) => sum + (record.entry?.sizeBytes ?? 0),
                    0,
                );
                if (existingBytes + params.entry.sizeBytes > params.quotaLimits.maxImportedPetBytesPerAccount) {
                    return { ok: false, error: "quota-exceeded" };
                }

                if (shouldPauseFirstPersist) {
                    shouldPauseFirstPersist = false;
                    firstPersistStarted.resolve();
                    await releaseFirstPersist.promise;
                }

                recordsByPetId.set(params.entry.accountPetId, {
                    accountId: params.accountId,
                    accountPetId: params.entry.accountPetId,
                    contentMode: "plain",
                    entry: params.entry,
                    asset: {
                        contentMode: "plain",
                        objectKey: params.objectKey,
                    },
                });
                return { ok: true };
            },
            async listAccountPets(accountId) {
                return listAccountPets(accountId);
            },
            async readAccountPet(accountId, petId) {
                const record = recordsByPetId.get(petId);
                if (!record || record.accountId !== accountId) {
                    return null;
                }
                return record;
            },
            async readAccountPetByDigest(accountId, digest) {
                return listAccountPets(accountId).find(record => record.entry?.digest === digest) ?? null;
            },
            async deleteAccountPet(accountId, petId) {
                const record = recordsByPetId.get(petId);
                if (!record || record.accountId !== accountId) {
                    return { ok: false, error: "not-found" };
                }

                recordsByPetId.delete(petId);
                return {
                    ok: true,
                    deletedAt: Date.now(),
                };
            },
        },
    };
}

function createInMemoryPrivateFilesThatCanFailDelete(): {
    privateFiles: {
        init(): Promise<void>;
        writePrivateFile(key: string, data: Uint8Array): Promise<void>;
        readPrivateFile(key: string): Promise<Uint8Array>;
        deletePrivateFile(key: string): Promise<void>;
    };
    failNextDelete(): void;
} {
    const storedFiles = new Map<string, Uint8Array>();
    let shouldFailNextDelete = false;

    return {
        failNextDelete() {
            shouldFailNextDelete = true;
        },
        privateFiles: {
            async init() {},
            async writePrivateFile(key, data) {
                storedFiles.set(key, data);
            },
            async readPrivateFile(key) {
                const stored = storedFiles.get(key);
                if (!stored) {
                    throw Object.assign(new Error("missing private file"), { code: "ENOENT" });
                }
                return stored;
            },
            async deletePrivateFile(key) {
                if (shouldFailNextDelete) {
                    shouldFailNextDelete = false;
                    throw new Error("delete failed");
                }
                storedFiles.delete(key);
            },
        },
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

    it.each([
        {
            name: "the persisted Account is E2EE",
            accountEncryptionMode: "e2ee",
            packageContentMode: "plain",
            assetContentMode: "plain",
        },
        {
            name: "the package content mode is malformed",
            accountEncryptionMode: "plain",
            packageContentMode: "future-mode",
            assetContentMode: "plain",
        },
        {
            name: "the selected asset content mode is malformed",
            accountEncryptionMode: "plain",
            packageContentMode: "plain",
            assetContentMode: "future-mode",
        },
    ] as const)("returns typed unavailable without metadata or bytes when $name", async ({
        accountEncryptionMode,
        packageContentMode,
        assetContentMode,
    }) => {
        const record = persistedPetWithModes({
            packageContentMode,
            assetContentMode,
        });
        const readPrivateFile = vi.fn(async () => WEBP_BYTES);
        const services = createAccountPetLibraryServices({
            privateFiles: {
                async init() {},
                async writePrivateFile() {},
                readPrivateFile,
                async deletePrivateFile() {},
            },
            persistence: {
                async persistAccountPet() {
                    return { ok: true };
                },
                async listAccountPets() {
                    return [record];
                },
                async readAccountPet() {
                    return record;
                },
                async readAccountPetByDigest() {
                    return record;
                },
                async deleteAccountPet() {
                    return { ok: false, error: "not-found" };
                },
            },
        });

        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode,
        })).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode,
            petId: "pet-1",
            assetId: "asset-1",
        })).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        expect(readPrivateFile).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "package row",
            record: {
                accountId: "account-1",
                accountPetId: "pet-1",
                contentMode: "plain",
                entry: null,
                asset: {
                    contentMode: "plain",
                    objectKey: "private/accounts/account-1/pets/pet-1/sheet.webp",
                },
            },
        },
        {
            name: "asset row",
            record: {
                accountId: "account-1",
                accountPetId: "pet-1",
                contentMode: "plain",
                entry: null,
                asset: null,
            },
        },
    ])("returns typed unavailable rather than omitting or 404 when a persisted $name is malformed", async ({
        record,
    }) => {
        const readPrivateFile = vi.fn(async () => WEBP_BYTES);
        const services = createAccountPetLibraryServices({
            privateFiles: {
                async init() {},
                async writePrivateFile() {},
                readPrivateFile,
                async deletePrivateFile() {},
            },
            persistence: {
                async persistAccountPet() {
                    return { ok: true };
                },
                async listAccountPets() {
                    return [record as unknown as PersistedAccountPet];
                },
                async readAccountPet() {
                    return record as unknown as PersistedAccountPet;
                },
                async readAccountPetByDigest() {
                    return record as unknown as PersistedAccountPet;
                },
                async deleteAccountPet() {
                    return { ok: false, error: "not-found" };
                },
            },
        });

        const unavailable = {
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        };
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual(unavailable);
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            petId: "pet-1",
            assetId: "asset-1",
        })).resolves.toEqual(unavailable);
        expect(readPrivateFile).not.toHaveBeenCalled();
    });

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
        expect(created.pet.digest).toBe(`sha256:${createHash('sha256')
            .update(stableManifestJson(requestFor(WEBP_BYTES).manifest)).update('\n').update(WEBP_BYTES).digest('hex')}`);
        expect(JSON.stringify(created.pet)).not.toContain("spritesheetBytes");

        const listedForOwner = await services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        });
        expect(listedForOwner).toEqual({ ok: true, pets: [created.pet] });

        const listedForOtherAccount = await services.listAccountPetsForAccount({
            accountId: "account-2",
            accountEncryptionMode: "plain",
        });
        expect(listedForOtherAccount).toEqual({ ok: true, pets: [] });

        const asset = await services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        });
        expect(asset).toEqual({
            ok: true,
            mediaType: "image/webp",
            bytes: WEBP_BYTES,
            digest: digest(WEBP_BYTES),
        });

        await expect(privateFiles.readPrivateFile(created.pet.spritesheetAssetRef.digest)).rejects.toThrow();
    });

    it("removes deleted account pet metadata and private asset bytes", async () => {
        await createAccount("account-1");
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
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
        const assetRow = await db.accountPetAsset.findFirstOrThrow({ where: { petPackageId: created.pet.accountPetId } });

        const deleted = await services.deleteAccountPetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
        });

        expect(deleted).toEqual({
            ok: true,
            accountPetId: created.pet.accountPetId,
            deletedAt: expect.any(Number),
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        })).resolves.toBeNull();
        await expect(privateFiles.readPrivateFile(assetRow.objectKey)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await db.accountPetPackage.findUniqueOrThrow({ where: { id: created.pet.accountPetId } })).deletedAt).not.toBeNull();
    });

    it("returns an internal error when create cleanup cannot delete the written private file", async () => {
        const privateFiles = createInMemoryPrivateFilesThatCanFailDelete();
        await privateFiles.privateFiles.init();
        privateFiles.failNextDelete();
        const services = createAccountPetLibraryServices({
            privateFiles: privateFiles.privateFiles,
            persistence: {
                async persistAccountPet() {
                    return { ok: false, error: "quota-exceeded" };
                },
                async listAccountPets() {
                    return [];
                },
                async readAccountPet() {
                    return null;
                },
                async readAccountPetByDigest() {
                    return null;
                },
                async deleteAccountPet() {
                    return { ok: false, error: "not-found" };
                },
            },
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
            errorCode: "internal_error",
            error: "internal_error",
        });
    });

    it("keeps the pet tombstoned when private file cleanup fails", async () => {
        await createAccount("account-1");
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
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
        if (!created.ok) {
            throw new Error("expected account pet creation to succeed");
        }

        const assetRow = await db.accountPetAsset.findFirstOrThrow({ where: { petPackageId: created.pet.accountPetId } });
        // Inject the unavailable filesystem boundary; metadata and private bytes are real.
        const removeBytes = privateFiles.deletePrivateFile;
        if (!removeBytes) throw new Error("expected local private-file deletion support");
        privateFiles.deletePrivateFile = vi.fn(removeBytes).mockRejectedValueOnce(new Error("private storage unavailable"));
        const firstDelete = await services.deleteAccountPetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
        });

        expect(firstDelete).toEqual({
            ok: false,
            errorCode: "internal_error",
            error: "internal_error",
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        })).resolves.toBeNull();
        expect((await db.accountPetPackage.findUniqueOrThrow({ where: { id: created.pet.accountPetId } })).deletedAt).not.toBeNull();
        await expect(privateFiles.readPrivateFile(assetRow.objectKey)).resolves.toEqual(WEBP_BYTES);
        privateFiles.deletePrivateFile = removeBytes;

        const secondDelete = await services.deleteAccountPetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
        });

        expect(secondDelete).toEqual({
            ok: false,
            errorCode: "not_found",
            error: "not_found",
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
    });

    it("preserves private bytes and live metadata when the database rejects the tombstone", async () => {
        await createAccount("account-1");
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
        });
        const created = await services.createAccountPetForAccount({ accountId: "account-1", request: requestFor(WEBP_BYTES) });
        if (!created.ok) throw new Error("expected account pet creation to succeed");
        // The disposable SQLite database itself refuses the update, exercising real rollback.
        await db.$executeRawUnsafe(`CREATE TRIGGER refuse_pet_tombstone BEFORE UPDATE OF "deletedAt" ON "AccountPetPackage"
            WHEN NEW."deletedAt" IS NOT NULL BEGIN SELECT RAISE(ABORT, 'pet tombstone unavailable'); END`);
        try {
            await expect(services.deleteAccountPetForAccount({ accountId: "account-1", petId: created.pet.accountPetId }))
                .resolves.toMatchObject({ ok: false, errorCode: "internal_error" });
            await expect(services.listAccountPetsForAccount({ accountId: "account-1", accountEncryptionMode: "plain" }))
                .resolves.toEqual({ ok: true, pets: [created.pet] });
            await expect(services.readAccountPetAssetForAccount({
                accountId: "account-1", accountEncryptionMode: "plain", petId: created.pet.accountPetId, assetId: null,
            })).resolves.toMatchObject({ ok: true, bytes: WEBP_BYTES });
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER refuse_pet_tombstone');
        }
        await expect(services.deleteAccountPetForAccount({ accountId: "account-1", petId: created.pet.accountPetId }))
            .resolves.toMatchObject({ ok: true });
    });

    it("reuses a normalized package across service recreation before quota admission or another asset write", async () => {
        const request = requestFor(webpAtlasHeader(PET_ATLAS_V2));
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        await createAccount("account-1");
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const privateWrites = vi.spyOn(privateFiles, "writePrivateFile");
        const firstServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            inspectAtlas: async () => ({
                width: 1536,
                height: 2288,
                hasAlpha: true,
                opaqueBounds: { x: 15, y: 20, width: 130, height: 170 },
                hasNeutralLookCell: false,
            }),
        });

        const created = await firstServices.createAccountPetForAccount({
            accountId: "account-1",
            request,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("expected account pet creation to succeed");

        expect(created.pet.opaqueBounds).toEqual({ x: 15, y: 20, width: 130, height: 170 });
        expect(created.pet.manifest).toEqual({ ...request.manifest, spriteVersionNumber: 2 });
        expect(created.pet.hasNeutralLookCell).toBe(false);

        const secondServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            maxImportedPetsPerAccount: 1,
            inspectAtlas: async () => ({
                width: 1536,
                height: 2288,
                hasAlpha: true,
            }),
        });

        await expect(secondServices.createAccountPetForAccount({ accountId: "account-1", request }))
            .resolves.toEqual({ ok: true, pet: created.pet, reused: true });
        expect(privateWrites).toHaveBeenCalledTimes(1);
        await createAccount("account-2");
        const other = await secondServices.createAccountPetForAccount({ accountId: "account-2", request });
        expect(other.ok).toBe(true);
        if (!other.ok) throw new Error("expected the other Account to create its own pet");
        expect(other.pet.accountPetId).not.toBe(created.pet.accountPetId);
        expect(other.pet.digest).toBe(created.pet.digest);
        expect(privateWrites).toHaveBeenCalledTimes(2);

        await expect(secondServices.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [created.pet] });
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

    it("enforces persisted quotas without reading the full library during creation", async () => {
        await createAccount("account-1");
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const persistence = createPrismaAccountPetLibraryPersistence();
        // Observe the real database boundary without replacing its reads or quota admission.
        const libraryReads = vi.spyOn(persistence, "listAccountPets");
        const privateWrites = vi.spyOn(privateFiles, "writePrivateFile");
        const ids = ["pet-1", "asset-1", "pet-2", "asset-2", "pet-3", "asset-3"];
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence,
            maxImportedPetsPerAccount: 2,
            createId: () => ids.shift() ?? "unexpected-id",
            inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
        });
        let createdPackages = 0;
        const create = () => services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES, `pet-${createdPackages++}`),
        });

        expect((await create()).ok).toBe(true);
        libraryReads.mockClear();

        expect((await create()).ok).toBe(true);
        expect(await create()).toMatchObject({ ok: false, errorCode: "quota_exceeded" });
        expect(libraryReads).not.toHaveBeenCalled();
        const refusedObjectKey = privateWrites.mock.calls.at(-1)?.[0];
        if (!refusedObjectKey) throw new Error("expected the quota-refused private file write");
        await expect(privateFiles.readPrivateFile(refusedObjectKey)).rejects.toMatchObject({ code: "ENOENT" });

        const listed = await services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        });
        expect(listed.ok && listed.pets.map((pet) => pet.accountPetId).sort()).toEqual(["pet-1", "pet-2"]);
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
            request: requestFor(WEBP_BYTES, "other"),
        });

        expect(first.ok).toBe(true);
        expect(second).toEqual({
            ok: false,
            errorCode: "quota_exceeded",
            error: "quota_exceeded",
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [expect.any(Object)] });
    });

    it("reuses a normalized package admitted concurrently before the per-account count quota", async () => {
        const request = requestFor(webpAtlasHeader(PET_ATLAS_V2));
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const privateWrites = vi.spyOn(privateFiles, "writePrivateFile");
        const pausedPersistence = createPersistenceThatPausesFirstPersist();
        const ids = ["pet-1", "asset-1", "pet-2", "asset-2"];
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: pausedPersistence.persistence,
            maxImportedPetsPerAccount: 1,
            createId: () => ids.shift() ?? "unexpected-id",
            inspectAtlas: async () => ({
                width: 1536,
                height: 2288,
                hasAlpha: true,
            }),
        });

        const firstCreate = services.createAccountPetForAccount({
            accountId: "account-1",
            request,
        });
        await pausedPersistence.waitForFirstPersistStart;
        const secondCreate = services.createAccountPetForAccount({
            accountId: "account-1",
            request,
        });
        pausedPersistence.releaseFirstPersist();

        const [first, second] = await Promise.all([firstCreate, secondCreate]);

        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error("expected the first normalized package import to succeed");
        expect(second).toEqual({ ok: true, pet: first.pet, reused: true });
        expect(privateWrites).toHaveBeenCalledTimes(1);
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [expect.any(Object)] });
    });

    it("enforces the per-account count quota inside Prisma persistence across service instances", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        await createAccount("account-1");
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const quotaHooks = createPrismaQuotaReadPauseHooks();
        const firstIds = ["pet-1", "asset-1"];
        const secondIds = ["pet-2", "asset-2"];
        const firstServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence({ hooks: quotaHooks.hooks }),
            maxImportedPetsPerAccount: 1,
            createId: () => firstIds.shift() ?? "unexpected-first-id",
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });
        const secondServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence({ hooks: quotaHooks.hooks }),
            maxImportedPetsPerAccount: 1,
            createId: () => secondIds.shift() ?? "unexpected-second-id",
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const secondAdmissionAttempt = createDeferred<void>();
        const originalTransaction = db.$transaction;
        let admissionAttempts = 0;
        // Observe the real contender's transaction acquisition request. SQLite
        // can block BEGIN before its callback or Account admission SQL runs.
        db.$transaction = new Proxy(originalTransaction, {
            apply(target, receiver, args: unknown[]) {
                const operation = args[0];
                if (typeof operation !== "function") return Reflect.apply(target, receiver, args);
                const pending = Reflect.apply(target, receiver, args);
                admissionAttempts += 1;
                if (admissionAttempts === 2) secondAdmissionAttempt.resolve();
                return pending;
            },
        });

        const firstCreate = firstServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        let secondCreate: ReturnType<typeof secondServices.createAccountPetForAccount> | undefined;
        let first: Awaited<typeof firstCreate>;
        let second: Awaited<typeof firstCreate>;
        try {
            await quotaHooks.waitForFirstQuotaRead;
            secondCreate = secondServices.createAccountPetForAccount({
                accountId: "account-1",
                request: requestFor(WEBP_BYTES, "other"),
            });
            await secondAdmissionAttempt.promise;
            quotaHooks.releaseQuotaReads();
            [first, second] = await Promise.all([firstCreate, secondCreate]);
        } finally {
            quotaHooks.releaseQuotaReads();
            await Promise.allSettled([firstCreate, ...(secondCreate ? [secondCreate] : [])]);
            db.$transaction = originalTransaction;
        }
        const results = [first, second];
        const successCount = results.filter((result) => result.ok).length;
        const quotaFailures = results.filter((result) => !result.ok && result.errorCode === "quota_exceeded");

        expect(successCount).toBe(1);
        expect(quotaFailures).toHaveLength(1);
        await expect(firstServices.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [expect.any(Object)] });
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
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
    });

    it("stores an E2EE Account's sealed package as ciphertext only and serves it back for opening", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const material = { type: "dataKey", machineKey: new Uint8Array(32).fill(5) } as const;
        await db.account.create({ data: { id: "account-e2ee", encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
        });
        const validated = await validateAccountPetCreateRequestV1(requestFor(WEBP_BYTES, "tide"), {
            inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
        });
        if (!validated.ok) throw new Error(validated.reason);
        const sealed = sealAccountPetPackageV1({ validated, material, randomBytes: (length) => new Uint8Array(randomBytes(length)) });
        if (!sealed.ok) throw new Error(sealed.reason);

        const limitedServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: createPrismaAccountPetLibraryPersistence(),
            maxSpritesheetBytes: WEBP_BYTES.byteLength - 3,
        });
        await expect(limitedServices.createAccountPetForAccount({
            accountId: "account-e2ee", accountEncryptionMode: "e2ee", storagePolicy: "optional", request: sealed.request,
        })).resolves.toMatchObject({ ok: false, errorCode: "invalid_request" });

        const created = await services.createAccountPetForAccount({
            accountId: "account-e2ee", accountEncryptionMode: "e2ee", storagePolicy: "optional", request: sealed.request,
        });
        expect(created).toMatchObject({ ok: true, pet: { content: sealed.request.content,
            spritesheetAssetRef: { digest: sealed.request.spritesheet.digest, sizeBytes: sealed.request.spritesheet.sizeBytes } } });
        if (!created.ok) throw new Error(created.errorCode);

        const row = await db.accountPetPackage.findFirstOrThrow({ where: { accountId: "account-e2ee" }, include: { assets: true } });
        expect(row.contentMode).toBe("encrypted");
        expect(row.assets[0]?.contentMode).toBe("encrypted");
        expect(JSON.stringify(row)).not.toContain("tide");
        expect(JSON.stringify(row)).not.toContain("Blink");

        const listed = await services.listAccountPetsForAccount({ accountId: "account-e2ee", accountEncryptionMode: "e2ee" });
        if (!listed.ok) throw new Error(listed.errorCode);
        const opened = openAccountPetStoredEntryForModeV1(listed.pets[0]!, { mode: "e2ee", material });
        expect(opened).toMatchObject({ manifest: { id: "tide" }, origin: { kind: "manualImport" } });

        const asset = await services.readAccountPetAssetForAccount({
            accountId: "account-e2ee", accountEncryptionMode: "e2ee", petId: created.pet.accountPetId, assetId: null,
        });
        if (!asset?.ok) throw new Error("asset unavailable");
        expect(asset.mediaType).toBe("application/octet-stream");
        const sheet = openAccountPetSpritesheetV1({ ciphertext: asset.bytes, material,
            expected: { mediaType: "image/webp", digest: opened!.spritesheetAssetRef.digest } });
        expect(sheet && Array.from(sheet)).toEqual(Array.from(WEBP_BYTES));
        // The Plain reader never discloses sealed rows.
        await expect(services.listAccountPetsForAccount({ accountId: "account-e2ee", accountEncryptionMode: "plain" }))
            .resolves.toMatchObject({ ok: false, errorCode: "custom_pet_sync_unavailable" });
    });

    it.each([
        { name: "a plaintext package for an E2EE Account", accountEncryptionMode: "e2ee", sealed: false },
        { name: "a sealed package for a Plain Account", accountEncryptionMode: "plain", sealed: true },
    ] as const)("refuses $name with a typed mismatch before writing private bytes", async ({ accountEncryptionMode, sealed }) => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles,
            inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
        });
        const plainRequest = requestFor(WEBP_BYTES);
        let request: unknown = plainRequest;
        if (sealed) {
            const validated = await validateAccountPetCreateRequestV1(plainRequest, {
                inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
            });
            if (!validated.ok) throw new Error(validated.reason);
            const result = sealAccountPetPackageV1({ validated, material: { type: "dataKey", machineKey: new Uint8Array(32).fill(5) },
                randomBytes: (length) => new Uint8Array(randomBytes(length)) });
            if (!result.ok) throw new Error(result.reason);
            request = result.request;
        }

        const created = await services.createAccountPetForAccount({
            accountId: "account-1", accountEncryptionMode, storagePolicy: "optional", request,
        });

        expect(created).toEqual({
            ok: false,
            errorCode: "account_encryption_mode_mismatch",
            error: "account_encryption_mode_mismatch",
        });
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

        const createParams = {
            accountId: "account-1",
            accountEncryptionMode: "plain",
            storagePolicy: "required_e2ee",
            request: requestFor(WEBP_BYTES),
        } as const;
        const created = await services.createAccountPetForAccount(createParams);

        expect(created).toEqual({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
        await expect(readdir(rootDir)).resolves.toEqual([]);
    });

    it("serializes concurrent account pet creation against the per-account byte quota", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const pausedPersistence = createPersistenceThatPausesFirstPersist();
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: pausedPersistence.persistence,
            maxImportedPetBytesPerAccount: packageSizeBytesFor(WEBP_BYTES),
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const firstCreate = services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        await pausedPersistence.waitForFirstPersistStart;
        const secondCreate = services.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES, "other"),
        });
        pausedPersistence.releaseFirstPersist();

        const [first, second] = await Promise.all([firstCreate, secondCreate]);

        expect(first.ok).toBe(true);
        expect(second).toEqual({
            ok: false,
            errorCode: "quota_exceeded",
            error: "quota_exceeded",
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [expect.any(Object)] });
    });
});

import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLocalPrivateFilesBackend } from "@/storage/privateFiles/privateFilesLocal";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createPrismaAccountPetLibraryPersistence,
    type AccountPetLibraryPersistence,
    type PrismaAccountPetLibraryPersistenceOptions,
    type PersistedAccountPet,
} from "./accountPetLibraryPersistence";
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
    waitForSecondQuotaRead: Promise<void>;
    releaseQuotaReads(): void;
} {
    const firstQuotaRead = createDeferred<void>();
    const secondQuotaRead = createDeferred<void>();
    const releaseQuotaReads = createDeferred<void>();
    let quotaReadCount = 0;

    return {
        waitForFirstQuotaRead: firstQuotaRead.promise,
        waitForSecondQuotaRead: secondQuotaRead.promise,
        releaseQuotaReads() {
            releaseQuotaReads.resolve();
        },
        hooks: {
            async afterQuotaRead() {
                quotaReadCount += 1;
                if (quotaReadCount === 1) {
                    firstQuotaRead.resolve();
                }
                if (quotaReadCount === 2) {
                    secondQuotaRead.resolve();
                }
                await releaseQuotaReads.promise;
            },
        },
    };
}

function createPersistenceThatPausesFirstPersist(): {
    persistence: AccountPetLibraryPersistence;
    waitForFirstPersistStart: Promise<void>;
    waitForSecondListCall: Promise<void>;
    releaseFirstPersist(): void;
} {
    const recordsByPetId = new Map<string, PersistedAccountPet>();
    const firstPersistStarted = createDeferred<void>();
    const secondListCalled = createDeferred<void>();
    const releaseFirstPersist = createDeferred<void>();
    let shouldPauseFirstPersist = true;
    let listCallCount = 0;

    function listAccountPets(accountId: string): PersistedAccountPet[] {
        return Array.from(recordsByPetId.values()).filter((record) => record.accountId === accountId);
    }

    return {
        waitForFirstPersistStart: firstPersistStarted.promise,
        waitForSecondListCall: secondListCalled.promise,
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
                listCallCount += 1;
                if (listCallCount === 2) {
                    secondListCalled.resolve();
                }
                return listAccountPets(accountId);
            },
            async readAccountPet(accountId, petId) {
                const record = recordsByPetId.get(petId);
                if (!record || record.accountId !== accountId) {
                    return null;
                }
                return record;
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

async function waitForSecondQuotaReadOrTimeout(waitForSecondListCall: Promise<void>, timeoutMs = 50): Promise<void> {
    await Promise.race([
        waitForSecondListCall,
        new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs);
        }),
    ]);
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

    it("keeps delete retriable when private file cleanup fails", async () => {
        const privateFiles = createInMemoryPrivateFilesThatCanFailDelete();
        await privateFiles.privateFiles.init();
        const services = createAccountPetLibraryServices({
            privateFiles: privateFiles.privateFiles,
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

        privateFiles.failNextDelete();
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
        })).resolves.toEqual({ ok: true, pets: [created.pet] });
        await expect(services.readAccountPetAssetForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
            petId: created.pet.accountPetId,
            assetId: created.pet.spritesheetAssetRef.assetId,
        })).resolves.toEqual({
            ok: true,
            mediaType: "image/webp",
            bytes: WEBP_BYTES,
            digest: digest(WEBP_BYTES),
        });

        const secondDelete = await services.deleteAccountPetForAccount({
            accountId: "account-1",
            petId: created.pet.accountPetId,
        });

        expect(secondDelete).toEqual({
            ok: true,
            accountPetId: created.pet.accountPetId,
            deletedAt: expect.any(Number),
        });
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [] });
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
        await expect(services.listAccountPetsForAccount({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        })).resolves.toEqual({ ok: true, pets: [expect.any(Object)] });
    });

    it("serializes concurrent account pet creation against the per-account count quota", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const pausedPersistence = createPersistenceThatPausesFirstPersist();
        const ids = ["pet-1", "asset-1", "pet-2", "asset-2"];
        const services = createAccountPetLibraryServices({
            privateFiles,
            persistence: pausedPersistence.persistence,
            maxImportedPetsPerAccount: 1,
            createId: () => ids.shift() ?? "unexpected-id",
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
            request: requestFor(WEBP_BYTES),
        });
        await waitForSecondQuotaReadOrTimeout(pausedPersistence.waitForSecondListCall);
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

    it("enforces the per-account count quota at the persistence boundary across service instances", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-account-pets-"));
        tempDirs.push(rootDir);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir });
        await privateFiles.init();
        const pausedPersistence = createPersistenceThatPausesFirstPersist();
        const firstIds = ["pet-1", "asset-1"];
        const secondIds = ["pet-2", "asset-2"];
        const firstServices = createAccountPetLibraryServices({
            privateFiles,
            persistence: pausedPersistence.persistence,
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
            persistence: pausedPersistence.persistence,
            maxImportedPetsPerAccount: 1,
            createId: () => secondIds.shift() ?? "unexpected-second-id",
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        const firstCreate = firstServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        await pausedPersistence.waitForFirstPersistStart;
        const secondCreate = secondServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        await waitForSecondQuotaReadOrTimeout(pausedPersistence.waitForSecondListCall);
        pausedPersistence.releaseFirstPersist();

        const [first, second] = await Promise.all([firstCreate, secondCreate]);
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

        const firstCreate = firstServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        await quotaHooks.waitForFirstQuotaRead;
        const secondCreate = secondServices.createAccountPetForAccount({
            accountId: "account-1",
            request: requestFor(WEBP_BYTES),
        });
        await quotaHooks.waitForSecondQuotaRead;
        quotaHooks.releaseQuotaReads();

        const [first, second] = await Promise.all([firstCreate, secondCreate]);
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

        const createParams = {
            accountId: "account-1",
            accountEncryptionMode: "e2ee",
            storagePolicy: "optional",
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
            request: requestFor(WEBP_BYTES),
        });
        await waitForSecondQuotaReadOrTimeout(pausedPersistence.waitForSecondListCall);
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

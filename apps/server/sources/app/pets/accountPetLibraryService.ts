import { createHash, randomUUID } from "node:crypto";

import {
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    PET_PACKAGE_LIMITS_V1,
    type AccountPetCreateRequestV1,
    type AccountPetCreateResponseV1,
    type AccountPetDeleteResponseV1,
    type AccountPetLibraryEntryV1,
    type AccountPetListResponseV1,
    type AccountPetSyncUnavailableResponseV1,
    type PetAssetMediaTypeV1,
} from "@happier-dev/protocol";

import type { PrivateFilesBackend } from "@/storage/privateFiles/privateFiles";

import {
    inspectPetAtlasWithSharp,
    validateAccountPetCreateRequest,
    type AccountPetCreateValidationOptions,
} from "./accountPetLibraryValidation";
import type {
    AccountPetLibraryPersistence,
    PersistedAccountPet,
} from "./accountPetLibraryPersistence";

export type AccountPetAssetReadResult = Readonly<{
    ok: true;
    mediaType: PetAssetMediaTypeV1;
    bytes: Uint8Array;
    digest: string;
}> | AccountPetSyncUnavailableResponseV1;

export type CreateAccountPetForAccountParams = Readonly<{
    accountId: string;
    accountEncryptionMode?: "plain" | "e2ee" | null;
    storagePolicy?: "required_e2ee" | "optional" | "plaintext_only" | null;
    request: unknown;
}>;

export type ListAccountPetsForAccountParams = Readonly<{
    accountId: string;
    accountEncryptionMode: "plain" | "e2ee";
}>;

export type ReadAccountPetAssetForAccountParams = Readonly<{
    accountId: string;
    accountEncryptionMode: "plain" | "e2ee";
    petId: string;
    assetId: string | null;
}>;

export type DeleteAccountPetForAccountParams = Readonly<{
    accountId: string;
    petId: string;
}>;

export type AccountPetLibraryServices = Readonly<{
    createAccountPetForAccount(params: CreateAccountPetForAccountParams): Promise<AccountPetCreateResponseV1>;
    listAccountPetsForAccount(params: ListAccountPetsForAccountParams): Promise<AccountPetListResponseV1>;
    readAccountPetAssetForAccount(params: ReadAccountPetAssetForAccountParams): Promise<AccountPetAssetReadResult | null>;
    deleteAccountPetForAccount(params: DeleteAccountPetForAccountParams): Promise<AccountPetDeleteResponseV1>;
}>;

export type AccountPetLibraryServiceOptions = Readonly<{
    privateFiles: PrivateFilesBackend;
    persistence?: AccountPetLibraryPersistence;
    maxManifestBytes?: number;
    maxSpritesheetBytes?: number;
    maxPackageBytes?: number;
    maxImportedPetsPerAccount?: number;
    maxImportedPetBytesPerAccount?: number;
    inspectAtlas?: AccountPetCreateValidationOptions["inspectAtlas"];
    nowMs?: () => number;
    createId?: () => string;
}>;

type StoredAccountPet = Readonly<{
    accountId: string;
    accountPetId: string;
    contentMode: "plain";
    entry: AccountPetLibraryEntryV1;
    asset: {
        contentMode: "plain";
        objectKey: string;
    };
}>;

type AccountMutationLockState = {
    pending: number;
    tail: Promise<void>;
};

async function deletePrivateFileOrThrow(privateFiles: PrivateFilesBackend, objectKey: string): Promise<void> {
    const deletePrivateFile = privateFiles.deletePrivateFile;
    if (!deletePrivateFile) {
        throw new Error("private file deletion is not supported by the configured backend");
    }
    await deletePrivateFile(objectKey);
}

function stableJson(value: unknown): string {
    return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function calculatePackageDigest(request: AccountPetCreateRequestV1, spritesheetBytes: Uint8Array): string {
    const hash = createHash("sha256");
    hash.update(stableJson(request.manifest));
    hash.update("\n");
    hash.update(spritesheetBytes);
    return `sha256:${hash.digest("hex")}`;
}

function digestHex(digest: string): string {
    return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : createHash("sha256").update(digest).digest("hex");
}

function keySegment(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function extensionForMediaType(mediaType: PetAssetMediaTypeV1): "png" | "webp" {
    return mediaType === "image/png" ? "png" : "webp";
}

function createPrivateObjectKey(params: {
    accountId: string;
    petId: string;
    assetDigest: string;
    mediaType: PetAssetMediaTypeV1;
}): string {
    return [
        "private",
        "accounts",
        keySegment(params.accountId),
        "pets",
        keySegment(params.petId),
        "sha256",
        `${digestHex(params.assetDigest)}.${extensionForMediaType(params.mediaType)}`,
    ].join("/");
}

function invalidCreateResponse(): AccountPetCreateResponseV1 {
    return {
        ok: false,
        errorCode: "invalid_request",
        error: "invalid_request",
    };
}

function quotaExceededResponse(): AccountPetCreateResponseV1 {
    return {
        ok: false,
        errorCode: "quota_exceeded",
        error: "quota_exceeded",
    };
}

function customPetSyncRequiresPlaintextResponse(): AccountPetCreateResponseV1 {
    return {
        ok: false,
        errorCode: "custom_pet_sync_requires_plaintext",
        error: "custom_pet_sync_requires_plaintext",
    };
}

function customPetSyncUnavailableResponse(): AccountPetSyncUnavailableResponseV1 {
    return {
        ok: false,
        errorCode: "custom_pet_sync_unavailable",
        error: "custom_pet_sync_unavailable",
    };
}

function isCustomPetSyncStorageAllowed(params: Pick<CreateAccountPetForAccountParams, "accountEncryptionMode" | "storagePolicy">): boolean {
    if (params.accountEncryptionMode === "e2ee") {
        return false;
    }
    if (params.storagePolicy === "required_e2ee") {
        return false;
    }
    return true;
}

function notFoundDeleteResponse(): AccountPetDeleteResponseV1 {
    return {
        ok: false,
        errorCode: "not_found",
        error: "not_found",
    };
}

function internalDeleteResponse(): AccountPetDeleteResponseV1 {
    return {
        ok: false,
        errorCode: "internal_error",
        error: "internal_error",
    };
}

function createInMemoryAccountPetLibraryPersistence(): AccountPetLibraryPersistence {
    const recordsByPetId = new Map<string, StoredAccountPet>();

    function accountRecords(accountId: string): StoredAccountPet[] {
        return Array.from(recordsByPetId.values()).filter((record) => record.accountId === accountId);
    }

    return {
        async persistAccountPet(params) {
            const existingRecords = accountRecords(params.accountId);
            if (existingRecords.length >= params.quotaLimits.maxImportedPetsPerAccount) {
                return { ok: false, error: "quota-exceeded" } as const;
            }

            const existingBytes = existingRecords.reduce((sum, record) => sum + record.entry.sizeBytes, 0);
            if (existingBytes + params.entry.sizeBytes > params.quotaLimits.maxImportedPetBytesPerAccount) {
                return { ok: false, error: "quota-exceeded" } as const;
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
            return { ok: true } as const;
        },
        async listAccountPets(accountId): Promise<PersistedAccountPet[]> {
            return accountRecords(accountId);
        },
        async readAccountPet(accountId, petId): Promise<PersistedAccountPet | null> {
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
    };
}

export function createAccountPetLibraryServices(options: AccountPetLibraryServiceOptions): AccountPetLibraryServices {
    const nowMs = options.nowMs ?? (() => Date.now());
    const createId = options.createId ?? (() => randomUUID());
    const inspectAtlas = options.inspectAtlas ?? inspectPetAtlasWithSharp;
    const persistence = options.persistence ?? createInMemoryAccountPetLibraryPersistence();
    const createLocksByAccountId = new Map<string, AccountMutationLockState>();

    async function withCreateLock<T>(accountId: string, action: () => Promise<T>): Promise<T> {
        let lock = createLocksByAccountId.get(accountId);
        if (!lock) {
            lock = {
                pending: 0,
                tail: Promise.resolve(),
            };
            createLocksByAccountId.set(accountId, lock);
        }

        lock.pending += 1;
        const previous = lock.tail.catch(() => {});
        let releaseCurrent!: () => void;
        lock.tail = new Promise<void>((resolve) => {
            releaseCurrent = resolve;
        });

        await previous;
        try {
            return await action();
        } finally {
            releaseCurrent();
            lock.pending -= 1;
            if (lock.pending === 0) {
                createLocksByAccountId.delete(accountId);
            }
        }
    }

    return {
        async createAccountPetForAccount(params) {
            if (!params.accountId) {
                return invalidCreateResponse();
            }
            if (!isCustomPetSyncStorageAllowed(params)) {
                return customPetSyncRequiresPlaintextResponse();
            }

            const validated = await validateAccountPetCreateRequest(params.request, {
                maxManifestBytes: options.maxManifestBytes ?? PET_PACKAGE_LIMITS_V1.maxManifestBytes,
                maxSpritesheetBytes: options.maxSpritesheetBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
                maxPackageBytes: options.maxPackageBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes,
                inspectAtlas,
            });
            if (!validated.ok) {
                return invalidCreateResponse();
            }

            const petId = createId();
            const assetId = createId();
            const timestamp = nowMs();
            const spritesheet = validated.request.spritesheet;
            const objectKey = createPrivateObjectKey({
                accountId: params.accountId,
                petId,
                assetDigest: spritesheet.digest,
                mediaType: spritesheet.mediaType,
            });
            const packageDigest = calculatePackageDigest(validated.request, validated.spritesheetBytes);
            const entry: AccountPetLibraryEntryV1 = {
                accountPetId: petId,
                packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
                manifest: validated.request.manifest,
                spritesheetAssetRef: {
                    assetId,
                    mediaType: spritesheet.mediaType,
                    digest: spritesheet.digest,
                    sizeBytes: spritesheet.sizeBytes,
                },
                digest: packageDigest,
                sizeBytes: Buffer.byteLength(stableJson(validated.request.manifest), "utf8") + spritesheet.sizeBytes,
                createdAt: timestamp,
                updatedAt: timestamp,
                origin: validated.request.origin,
            };

            return await withCreateLock(params.accountId, async () => {
                const existingRecords = await persistence.listAccountPets(params.accountId);
                const maxImportedPetsPerAccount = options.maxImportedPetsPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount;
                if (existingRecords.length >= maxImportedPetsPerAccount) {
                    return quotaExceededResponse();
                }

                const maxImportedPetBytesPerAccount = options.maxImportedPetBytesPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount;
                const existingBytes = existingRecords.reduce(
                    (sum, record) => sum + (record.entry?.sizeBytes ?? 0),
                    0,
                );
                if (existingBytes + entry.sizeBytes > maxImportedPetBytesPerAccount) {
                    return quotaExceededResponse();
                }

                await options.privateFiles.writePrivateFile(objectKey, validated.spritesheetBytes);
                try {
                    const persisted = await persistence.persistAccountPet({
                        accountId: params.accountId,
                        entry,
                        objectKey,
                        quotaLimits: {
                            maxImportedPetsPerAccount,
                            maxImportedPetBytesPerAccount,
                        },
                    });
                    if (!persisted.ok) {
                        try {
                            await deletePrivateFileOrThrow(options.privateFiles, objectKey);
                        } catch {
                            return {
                                ok: false,
                                errorCode: "internal_error",
                                error: "internal_error",
                            };
                        }
                        if (persisted.error === "quota-exceeded") {
                            return quotaExceededResponse();
                        }
                        if (persisted.error === "plaintext-required") {
                            return customPetSyncRequiresPlaintextResponse();
                        }
                        return {
                            ok: false,
                            errorCode: "internal_error",
                            error: "internal_error",
                        };
                    }
                } catch {
                    try {
                        await deletePrivateFileOrThrow(options.privateFiles, objectKey);
                    } catch {
                        return {
                            ok: false,
                            errorCode: "internal_error",
                            error: "internal_error",
                        };
                    }
                    return {
                        ok: false,
                        errorCode: "internal_error",
                        error: "internal_error",
                    };
                }

                return { ok: true, pet: entry };
            });
        },
        async listAccountPetsForAccount(params) {
            if (params.accountEncryptionMode !== "plain") {
                return customPetSyncUnavailableResponse();
            }
            const records = await persistence.listAccountPets(params.accountId);
            const pets: AccountPetLibraryEntryV1[] = [];
            for (const record of records) {
                if (
                    !record.entry
                    || !record.asset
                    || record.contentMode !== "plain"
                    || record.asset.contentMode !== "plain"
                ) {
                    return customPetSyncUnavailableResponse();
                }
                pets.push(record.entry);
            }
            return {
                ok: true,
                pets,
            };
        },
        async readAccountPetAssetForAccount(params) {
            if (params.accountEncryptionMode !== "plain") {
                return customPetSyncUnavailableResponse();
            }
            const record = await persistence.readAccountPet(params.accountId, params.petId);
            if (!record) {
                return null;
            }
            if (
                !record.entry
                || !record.asset
                || record.contentMode !== "plain"
                || record.asset.contentMode !== "plain"
            ) {
                return customPetSyncUnavailableResponse();
            }
            const assetRef = record.entry.spritesheetAssetRef;
            if (params.assetId !== null && params.assetId !== assetRef.assetId) {
                return null;
            }
            const bytes = await options.privateFiles.readPrivateFile(record.asset.objectKey);
            return {
                ok: true,
                mediaType: assetRef.mediaType,
                bytes,
                digest: assetRef.digest,
            };
        },
        async deleteAccountPetForAccount(params) {
            if (!params.accountId || !params.petId) {
                return notFoundDeleteResponse();
            }
            const existingRecord = await persistence.readAccountPet(params.accountId, params.petId);
            if (!existingRecord) {
                return notFoundDeleteResponse();
            }
            if (existingRecord.asset) {
                try {
                    await deletePrivateFileOrThrow(options.privateFiles, existingRecord.asset.objectKey);
                } catch {
                    return internalDeleteResponse();
                }
            }
            const deleted = await persistence.deleteAccountPet(params.accountId, params.petId);
            if (!deleted.ok) {
                return deleted.error === "not-found" ? notFoundDeleteResponse() : internalDeleteResponse();
            }
            return {
                ok: true,
                accountPetId: params.petId,
                deletedAt: deleted.deletedAt,
            };
        },
    };
}

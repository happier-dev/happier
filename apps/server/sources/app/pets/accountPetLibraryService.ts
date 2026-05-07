import { createHash, randomUUID } from "node:crypto";

import {
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    PET_PACKAGE_LIMITS_V1,
    type AccountPetCreateRequestV1,
    type AccountPetCreateResponseV1,
    type AccountPetDeleteResponseV1,
    type AccountPetLibraryEntryV1,
    type PetAssetMediaTypeV1,
} from "@happier-dev/protocol";

import type { PrivateFilesBackend } from "@/storage/privateFiles/privateFiles";

import {
    inspectPetAtlasWithSharp,
    validateAccountPetCreateRequest,
    type AccountPetCreateValidationOptions,
} from "./accountPetLibraryValidation";
import {
    AccountPetQuotaExceededError,
    isAccountPetQuotaExceededError,
    type AccountPetLibraryPersistence,
    type PersistedAccountPet,
} from "./accountPetLibraryPersistence";

type AccountPetCustomSyncStoragePolicy = "required_e2ee" | "optional" | "plaintext_only";
type AccountPetCustomSyncAccountMode = "plain" | "e2ee";

export type AccountPetAssetReadResult = Readonly<{
    mediaType: PetAssetMediaTypeV1;
    bytes: Uint8Array;
    digest: string;
    sizeBytes: number;
}>;

export type CreateAccountPetForAccountParams = Readonly<{
    accountId: string;
    request: unknown;
    accountEncryptionMode?: AccountPetCustomSyncAccountMode;
    storagePolicy?: AccountPetCustomSyncStoragePolicy;
}>;

export type ListAccountPetsForAccountParams = Readonly<{
    accountId: string;
}>;

export type ReadAccountPetAssetForAccountParams = Readonly<{
    accountId: string;
    petId: string;
    assetId: string | null;
}>;

export type DeleteAccountPetForAccountParams = Readonly<{
    accountId: string;
    petId: string;
}>;

export type AccountPetLibraryServices = Readonly<{
    createAccountPetForAccount(params: CreateAccountPetForAccountParams): Promise<AccountPetCreateResponseV1>;
    listAccountPetsForAccount(params: ListAccountPetsForAccountParams): Promise<AccountPetLibraryEntryV1[]>;
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
    entry: AccountPetLibraryEntryV1;
    asset: {
        objectKey: string;
    };
}>;

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

function calculateAssetDigest(bytes: Uint8Array): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function notFoundDeleteResponse(): AccountPetDeleteResponseV1 {
    return {
        ok: false,
        errorCode: "not_found",
        error: "not_found",
    };
}

function canStoreCustomPetForAccount(params: Pick<CreateAccountPetForAccountParams, "accountEncryptionMode" | "storagePolicy">): boolean {
    if (params.storagePolicy === "required_e2ee") {
        return false;
    }
    if (params.accountEncryptionMode === "e2ee") {
        return false;
    }
    return true;
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
            const records = accountRecords(params.accountId);
            if (
                typeof params.maxImportedPetsPerAccount === "number"
                && records.length >= params.maxImportedPetsPerAccount
            ) {
                throw new AccountPetQuotaExceededError();
            }
            if (typeof params.maxImportedPetBytesPerAccount === "number") {
                const existingBytes = records.reduce((sum, record) => sum + record.entry.sizeBytes, 0);
                if (existingBytes + params.entry.sizeBytes > params.maxImportedPetBytesPerAccount) {
                    throw new AccountPetQuotaExceededError();
                }
            }
            recordsByPetId.set(params.entry.accountPetId, {
                accountId: params.accountId,
                entry: params.entry,
                asset: { objectKey: params.objectKey },
            });
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
                objectKeys: [record.asset.objectKey],
            };
        },
    };
}

export function createAccountPetLibraryServices(options: AccountPetLibraryServiceOptions): AccountPetLibraryServices {
    const nowMs = options.nowMs ?? (() => Date.now());
    const createId = options.createId ?? (() => randomUUID());
    const inspectAtlas = options.inspectAtlas ?? inspectPetAtlasWithSharp;
    const persistence = options.persistence ?? createInMemoryAccountPetLibraryPersistence();

    return {
        async createAccountPetForAccount(params) {
            if (!params.accountId) {
                return invalidCreateResponse();
            }
            if (!canStoreCustomPetForAccount(params)) {
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

            await options.privateFiles.writePrivateFile(objectKey, validated.spritesheetBytes);
            try {
                await persistence.persistAccountPet({
                    accountId: params.accountId,
                    entry,
                    objectKey,
                    maxImportedPetsPerAccount: options.maxImportedPetsPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount,
                    maxImportedPetBytesPerAccount:
                        options.maxImportedPetBytesPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount,
                });
            } catch (error) {
                await options.privateFiles.deletePrivateFile?.(objectKey).catch(() => {});
                if (isAccountPetQuotaExceededError(error)) {
                    return quotaExceededResponse();
                }
                return {
                    ok: false,
                    errorCode: "internal_error",
                    error: "internal_error",
                };
            }

            return { ok: true, pet: entry };
        },
        async listAccountPetsForAccount(params) {
            const records = await persistence.listAccountPets(params.accountId);
            return records.map((record) => record.entry);
        },
        async readAccountPetAssetForAccount(params) {
            const record = await persistence.readAccountPet(params.accountId, params.petId);
            if (!record) {
                return null;
            }
            const assetRef = record.entry.spritesheetAssetRef;
            if (params.assetId !== null && params.assetId !== assetRef.assetId) {
                return null;
            }
            const bytes = await options.privateFiles.readPrivateFile(record.asset.objectKey).catch(() => null);
            if (!bytes || bytes.byteLength !== assetRef.sizeBytes || calculateAssetDigest(bytes) !== assetRef.digest) {
                return null;
            }
            return {
                mediaType: assetRef.mediaType,
                bytes,
                digest: assetRef.digest,
                sizeBytes: assetRef.sizeBytes,
            };
        },
        async deleteAccountPetForAccount(params) {
            if (!params.accountId || !params.petId) {
                return notFoundDeleteResponse();
            }
            const deleted = await persistence.deleteAccountPet(params.accountId, params.petId);
            if (!deleted.ok) {
                return deleted.error === "not-found" ? notFoundDeleteResponse() : internalDeleteResponse();
            }
            for (const objectKey of deleted.objectKeys) {
                await options.privateFiles.deletePrivateFile?.(objectKey).catch(() => {});
            }
            return {
                ok: true,
                accountPetId: params.petId,
                deletedAt: deleted.deletedAt,
            };
        },
    };
}

import { createHash, randomUUID } from "node:crypto";

import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';
import { isAccountPetEncryptedLibraryEntryV1, type AccountPetCreateResponseV1, type AccountPetDeleteResponseV1, type AccountPetEncryptedLibraryEntryV1, type AccountPetLibraryEntryV1, type AccountPetListResponseV1, type AccountPetStoredLibraryEntryV1, type AccountPetSyncUnavailableResponseV1, type PetAssetMediaTypeV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { admitAccountPetEncryptedCreateRequestV1, isAccountPetEncryptedCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';

import type { PrivateFilesBackend } from "@/storage/privateFiles/privateFiles";
import { ACCOUNT_PET_PRIVATE_FILE_PREFIX } from "@/storage/privateFiles/privateFileKeys";

import {
    inspectPetAtlasWithSharp,
    validateAccountPetCreateRequest,
    type AccountPetCreateValidationOptions,
} from "./accountPetLibraryValidation";
import {
    ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE,
    accountPetContentModeForEntry,
    type AccountPetLibraryPersistence,
    type PersistedAccountPet,
} from "./accountPetLibraryPersistence";

export type AccountPetAssetReadResult = Readonly<{
    ok: true;
    mediaType: PetAssetMediaTypeV1 | typeof ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE;
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
    contentMode: "plain" | "encrypted";
    entry: AccountPetStoredLibraryEntryV1;
    asset: {
        contentMode: "plain" | "encrypted";
        objectKey: string;
    };
}>;

type AccountMutationLockState = {
    pending: number;
    tail: Promise<void>;
};

/** Mode/envelope agreement: Plain Accounts read plaintext rows, E2EE Accounts sealed rows. */
function isReadableAccountPet(record: PersistedAccountPet, accountEncryptionMode: "plain" | "e2ee"): record is StoredAccountPet {
    if (!record.entry || !record.asset) return false;
    const contentMode = accountPetContentModeForEntry(record.entry);
    return record.contentMode === contentMode && record.asset.contentMode === contentMode
        && contentMode === (accountEncryptionMode === "e2ee" ? "encrypted" : "plain");
}

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

function digestHex(digest: string): string {
    return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : createHash("sha256").update(digest).digest("hex");
}

function keySegment(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function extensionForMediaType(mediaType: PetAssetMediaTypeV1 | typeof ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE): "png" | "webp" | "bin" {
    return mediaType === ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE ? "bin" : mediaType === "image/png" ? "png" : "webp";
}

function createPrivateObjectKey(params: {
    accountId: string;
    petId: string;
    assetDigest: string;
    mediaType: PetAssetMediaTypeV1 | typeof ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE;
}): string {
    return [
        ACCOUNT_PET_PRIVATE_FILE_PREFIX,
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

function accountEncryptionModeMismatchResponse(): AccountPetCreateResponseV1 {
    return {
        ok: false,
        errorCode: "account_encryption_mode_mismatch",
        error: "account_encryption_mode_mismatch",
    };
}

function internalCreateResponse(): AccountPetCreateResponseV1 {
    return { ok: false, errorCode: "internal_error", error: "internal_error" };
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

            const contentMode = accountPetContentModeForEntry(params.entry);
            recordsByPetId.set(params.entry.accountPetId, {
                accountId: params.accountId,
                accountPetId: params.entry.accountPetId,
                contentMode,
                entry: params.entry,
                asset: {
                    contentMode,
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
        async readAccountPetByDigest(accountId, digest): Promise<PersistedAccountPet | null> {
            return accountRecords(accountId).find(record => record.entry.digest === digest) ?? null;
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

    const quotaLimits = () => ({
        maxImportedPetsPerAccount: options.maxImportedPetsPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount,
        maxImportedPetBytesPerAccount: options.maxImportedPetBytesPerAccount ?? PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount,
    });

    /** Called under the Account create lock: private bytes first, then the quota-checked row, cleaning up on refusal. */
    async function persistWithPrivateFile(params: Readonly<{
        accountId: string;
        entry: AccountPetStoredLibraryEntryV1;
        objectKey: string;
        bytes: Uint8Array;
    }>): Promise<AccountPetCreateResponseV1> {
        await options.privateFiles.writePrivateFile(params.objectKey, params.bytes);
        let refusal: AccountPetCreateResponseV1;
        try {
            const persisted = await persistence.persistAccountPet({
                accountId: params.accountId,
                entry: params.entry,
                objectKey: params.objectKey,
                quotaLimits: quotaLimits(),
            });
            if (persisted.ok) return { ok: true, pet: params.entry };
            refusal = persisted.error === "quota-exceeded" ? quotaExceededResponse()
                : persisted.error === "mode-mismatch" ? accountEncryptionModeMismatchResponse()
                    : internalCreateResponse();
        } catch {
            refusal = internalCreateResponse();
        }
        try {
            await deletePrivateFileOrThrow(options.privateFiles, params.objectKey);
        } catch {
            return internalCreateResponse();
        }
        return refusal;
    }

    /**
     * E2EE create: the writing client validated and sealed the package. The Home admits
     * ciphertext structure and size, then quota; it has no plaintext digest to reuse.
     */
    async function createEncryptedAccountPet(accountId: string, request: unknown): Promise<AccountPetCreateResponseV1> {
        const admitted = admitAccountPetEncryptedCreateRequestV1(request, options);
        if (!admitted) return invalidCreateResponse();
        const petId = createId();
        const assetId = createId();
        const timestamp = nowMs();
        const objectKey = createPrivateObjectKey({
            accountId,
            petId,
            assetDigest: admitted.spritesheetDigest,
            mediaType: ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE,
        });
        const contentBytes = Buffer.byteLength(admitted.content.c, "utf8");
        const entry: AccountPetEncryptedLibraryEntryV1 = {
            accountPetId: petId,
            packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
            content: admitted.content,
            spritesheetAssetRef: {
                assetId,
                digest: admitted.spritesheetDigest,
                sizeBytes: admitted.spritesheetCiphertext.byteLength,
            },
            digest: `sha256:${createHash("sha256").update(admitted.content.c).update("\n").update(admitted.spritesheetCiphertext).digest("hex")}`,
            sizeBytes: contentBytes + admitted.spritesheetCiphertext.byteLength,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        return await withCreateLock(accountId, () => persistWithPrivateFile({
            accountId, entry, objectKey, bytes: admitted.spritesheetCiphertext,
        }));
    }

    return {
        async createAccountPetForAccount(params) {
            if (!params.accountId) {
                return invalidCreateResponse();
            }
            const sealedRequest = isAccountPetEncryptedCreateRequestV1(params.request);
            if (params.accountEncryptionMode === "e2ee") {
                return sealedRequest
                    ? await createEncryptedAccountPet(params.accountId, params.request)
                    : accountEncryptionModeMismatchResponse();
            }
            if (sealedRequest) {
                return accountEncryptionModeMismatchResponse();
            }
            if (params.storagePolicy === "required_e2ee") {
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
            const packageDigest = validated.packageDigest;
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
                ...(validated.opaqueBounds ? { opaqueBounds: validated.opaqueBounds } : {}),
                ...(validated.hasNeutralLookCell !== undefined ? { hasNeutralLookCell: validated.hasNeutralLookCell } : {}),
            };

            return await withCreateLock(params.accountId, async () => {
                // Plaintext package-digest reuse is a Plain-Account Home decision; E2EE reuse is decided by the client.
                const existing = await persistence.readAccountPetByDigest(params.accountId, packageDigest);
                if (existing) {
                    return isReadableAccountPet(existing, "plain")
                        ? { ok: true, pet: existing.entry, reused: true }
                        : internalCreateResponse();
                }
                return await persistWithPrivateFile({
                    accountId: params.accountId, entry, objectKey, bytes: validated.spritesheetBytes,
                });
            });
        },
        async listAccountPetsForAccount(params) {
            const records = await persistence.listAccountPets(params.accountId);
            const pets: AccountPetStoredLibraryEntryV1[] = [];
            for (const record of records) {
                if (!isReadableAccountPet(record, params.accountEncryptionMode)) {
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
            const record = await persistence.readAccountPet(params.accountId, params.petId);
            if (!record) {
                return null;
            }
            if (!isReadableAccountPet(record, params.accountEncryptionMode)) {
                return customPetSyncUnavailableResponse();
            }
            const assetRef = record.entry.spritesheetAssetRef;
            if (params.assetId !== null && params.assetId !== assetRef.assetId) {
                return null;
            }
            const bytes = await options.privateFiles.readPrivateFile(record.asset.objectKey);
            return {
                ok: true,
                mediaType: isAccountPetEncryptedLibraryEntryV1(record.entry) ? ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE : record.entry.spritesheetAssetRef.mediaType,
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
            const deleted = await persistence.deleteAccountPet(params.accountId, params.petId);
            if (!deleted.ok) {
                return deleted.error === "not-found" ? notFoundDeleteResponse() : internalDeleteResponse();
            }
            if (existingRecord.asset) {
                try {
                    await deletePrivateFileOrThrow(options.privateFiles, existingRecord.asset.objectKey);
                } catch {
                    return internalDeleteResponse();
                }
            }
            return {
                ok: true,
                accountPetId: params.petId,
                deletedAt: deleted.deletedAt,
            };
        },
    };
}

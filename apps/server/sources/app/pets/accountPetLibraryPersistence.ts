import type { Prisma } from "@prisma/client";
import { z } from "zod/mini";

import { AccountPetEncryptedLibraryEntryV1Schema, AccountPetOriginV1Schema, PetAssetMediaTypeV1Schema, isAccountPetEncryptedLibraryEntryV1, type AccountPetStoredLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import { PetPackageManifestV1Schema } from '@happier-dev/protocol/pets/manifest';
import { PetCellBoundsV1Schema } from '@happier-dev/protocol/pets/atlasPixelInspection';

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { inTx } from "@/storage/inTx";

export type PersistedAccountPet = Readonly<{
    accountId: string;
    accountPetId: string;
    contentMode: string;
    entry: AccountPetStoredLibraryEntryV1 | null;
    asset: {
        contentMode: string;
        objectKey: string;
    } | null;
}>;

export type PersistAccountPetParams = Readonly<{
    accountId: string;
    /** A plaintext entry persists for a Plain Account and a sealed entry for an E2EE Account. */
    entry: AccountPetStoredLibraryEntryV1;
    objectKey: string;
}>;

export type DeletePersistedAccountPetResult =
    | Readonly<{
        ok: true;
        deletedAt: number;
    }>
    | Readonly<{ ok: false; error: "not-found" | "internal" }>;

export type AccountPetQuotaLimits = Readonly<{
    maxImportedPetsPerAccount: number;
    maxImportedPetBytesPerAccount: number;
}>;

export type PersistAccountPetResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: "mode-mismatch" | "quota-exceeded" | "internal" }>;

export type AccountPetLibraryPersistence = Readonly<{
    persistAccountPet(params: PersistAccountPetParams & { quotaLimits: AccountPetQuotaLimits }): Promise<PersistAccountPetResult>;
    listAccountPets(accountId: string): Promise<PersistedAccountPet[]>;
    readAccountPet(accountId: string, petId: string): Promise<PersistedAccountPet | null>;
    readAccountPetByDigest(accountId: string, digest: string): Promise<PersistedAccountPet | null>;
    deleteAccountPet(accountId: string, petId: string): Promise<DeletePersistedAccountPetResult>;
}>;

type AccountPetAssetRow = Readonly<{
    id: string;
    contentMode: string;
    objectKey: string;
    byteLength: number;
    mediaType: string;
    digest: string;
}>;

type AccountPetPackageRow = Readonly<{
    id: string;
    accountId: string;
    contentMode: string;
    packageFormat: string;
    manifest: unknown;
    digest: string;
    sizeBytes: number;
    origin: unknown;
    createdAt: Date;
    updatedAt: Date;
    assets: AccountPetAssetRow[];
}>;

/** Sealed E2EE rows keep the Account envelope in the manifest column; origin holds no content. */
const StoredEncryptedPetContentSchema = z.strictObject({ t: z.literal("encrypted"), c: z.string() });

/** Content representation of a persisted row, decided by the entry the writer admitted. */
export function accountPetContentModeForEntry(entry: AccountPetStoredLibraryEntryV1): "plain" | "encrypted" {
    return isAccountPetEncryptedLibraryEntryV1(entry) ? "encrypted" : "plain";
}

// The manifest JSON column retains server-measured metadata without changing the
// imported package manifest or requiring a second pixel scan on library reads.
const StoredAccountPetManifestV1Schema = z.extend(PetPackageManifestV1Schema, {
    opaqueBounds: z.optional(PetCellBoundsV1Schema),
    hasNeutralLookCell: z.optional(z.boolean()),
});

/** Sealed spritesheets are opaque bytes to the Home; the real media type is inside the envelope. */
export const ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE = "application/octet-stream";

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function mapAccountPetRow(row: AccountPetPackageRow): PersistedAccountPet {
    const asset = row.assets[0];
    const persistedAsset = asset
        ? {
            contentMode: asset.contentMode,
            objectKey: asset.objectKey,
        }
        : null;
    if (asset && row.contentMode === "encrypted" && asset.contentMode === "encrypted") {
        const content = StoredEncryptedPetContentSchema.safeParse(row.manifest);
        const entry = content.success ? AccountPetEncryptedLibraryEntryV1Schema.safeParse({
            accountPetId: row.id,
            packageFormat: row.packageFormat,
            content: content.data,
            spritesheetAssetRef: { assetId: asset.id, digest: asset.digest, sizeBytes: asset.byteLength },
            digest: row.digest,
            sizeBytes: row.sizeBytes,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
        }) : null;
        return {
            accountId: row.accountId,
            accountPetId: row.id,
            contentMode: row.contentMode,
            entry: entry?.success ? entry.data : null,
            asset: persistedAsset,
        };
    }
    if (!asset || row.packageFormat !== PET_PACKAGE_FORMAT_CODEX_ATLAS_V1) {
        return {
            accountId: row.accountId,
            accountPetId: row.id,
            contentMode: row.contentMode,
            entry: null,
            asset: persistedAsset,
        };
    }

    const mediaType = PetAssetMediaTypeV1Schema.safeParse(asset.mediaType);
    const manifest = StoredAccountPetManifestV1Schema.safeParse(row.manifest);
    const origin = AccountPetOriginV1Schema.safeParse(row.origin);
    if (!mediaType.success || !manifest.success || !origin.success) {
        return {
            accountId: row.accountId,
            accountPetId: row.id,
            contentMode: row.contentMode,
            entry: null,
            asset: persistedAsset,
        };
    }

    const { opaqueBounds, hasNeutralLookCell, ...packageManifest } = manifest.data;
    return {
        accountId: row.accountId,
        accountPetId: row.id,
        contentMode: row.contentMode,
        entry: {
            accountPetId: row.id,
            packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
            manifest: packageManifest,
            ...(opaqueBounds ? { opaqueBounds } : {}),
            ...(hasNeutralLookCell !== undefined ? { hasNeutralLookCell } : {}),
            spritesheetAssetRef: {
                assetId: asset.id,
                mediaType: mediaType.data,
                digest: asset.digest,
                sizeBytes: asset.byteLength,
            },
            digest: row.digest,
            sizeBytes: row.sizeBytes,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
            origin: origin.data,
        },
        asset: persistedAsset,
    };
}

function mapRows(rows: AccountPetPackageRow[]): PersistedAccountPet[] {
    return rows.map(mapAccountPetRow);
}

export type PrismaAccountPetLibraryPersistenceOptions = Readonly<{
    hooks?: Readonly<{
        afterQuotaRead?: () => Promise<void>;
    }>;
}>;

export function createPrismaAccountPetLibraryPersistence(
    options: PrismaAccountPetLibraryPersistenceOptions = {},
): AccountPetLibraryPersistence {
    return {
        async persistAccountPet(params) {
            try {
                return await inTx(async (tx): Promise<PersistAccountPetResult> => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId, "serializing");
                    const account = await tx.account.findUnique({
                        where: { id: params.accountId },
                        select: {
                            encryptionMode: true,
                            publicKey: true,
                            contentPublicKey: true,
                            contentPublicKeySig: true,
                        },
                    });
                    const accountCurrentness = account
                        ? deriveAccountEncryptionCurrentnessFromRow(account)
                        : null;
                    // The write fence decides mode against the persisted Account inside this transaction.
                    const contentMode = accountPetContentModeForEntry(params.entry);
                    if (
                        !accountCurrentness
                        || accountCurrentness.status !== "ready"
                        || accountCurrentness.currentness.encryptionMode !== (contentMode === "encrypted" ? "e2ee" : "plain")
                    ) {
                        return { ok: false, error: "mode-mismatch" };
                    }
                    const entry = params.entry;
                    const sealed = isAccountPetEncryptedLibraryEntryV1(entry);

                    const aggregate = await tx.accountPetPackage.aggregate({
                        where: {
                            accountId: params.accountId,
                            deletedAt: null,
                        },
                        _count: {
                            _all: true,
                        },
                        _sum: {
                            sizeBytes: true,
                        },
                    });

                    await options.hooks?.afterQuotaRead?.();

                    if (aggregate._count._all >= params.quotaLimits.maxImportedPetsPerAccount) {
                        return { ok: false, error: "quota-exceeded" };
                    }

                    const existingBytes = aggregate._sum.sizeBytes ?? 0;
                    if (existingBytes + params.entry.sizeBytes > params.quotaLimits.maxImportedPetBytesPerAccount) {
                        return { ok: false, error: "quota-exceeded" };
                    }

                    await tx.accountPetPackage.create({
                        data: {
                            id: entry.accountPetId,
                            accountId: params.accountId,
                            packageFormat: entry.packageFormat,
                            contentMode,
                            manifest: toPrismaJson(sealed ? entry.content : {
                                ...entry.manifest,
                                ...(entry.opaqueBounds ? { opaqueBounds: entry.opaqueBounds } : {}),
                                ...(entry.hasNeutralLookCell !== undefined ? { hasNeutralLookCell: entry.hasNeutralLookCell } : {}),
                            }),
                            digest: entry.digest,
                            sizeBytes: entry.sizeBytes,
                            origin: toPrismaJson(sealed ? {} : entry.origin),
                            version: 1,
                            createdAt: new Date(params.entry.createdAt),
                            updatedAt: new Date(params.entry.updatedAt),
                        },
                    });
                    await tx.accountPetAsset.create({
                        data: {
                            id: params.entry.spritesheetAssetRef.assetId,
                            accountId: params.accountId,
                            petPackageId: params.entry.accountPetId,
                            contentMode,
                            storageKind: "privateFile",
                            objectKey: params.objectKey,
                            byteLength: params.entry.spritesheetAssetRef.sizeBytes,
                            mediaType: sealed ? ACCOUNT_PET_SEALED_ASSET_MEDIA_TYPE : entry.spritesheetAssetRef.mediaType,
                            digest: params.entry.spritesheetAssetRef.digest,
                            createdAt: new Date(params.entry.createdAt),
                            updatedAt: new Date(params.entry.updatedAt),
                        },
                    });

                    await markAccountChanged(tx, {
                        accountId: params.accountId,
                        kind: "pet",
                        entityId: params.entry.accountPetId,
                        hint: {
                            domain: "accountPet",
                            action: "create",
                            accountPetId: params.entry.accountPetId,
                            changedAt: params.entry.updatedAt,
                            digest: params.entry.digest,
                            version: 1,
                        },
                    });

                    return { ok: true };
                });
            } catch {
                return { ok: false, error: "internal" };
            }
        },
        async listAccountPets(accountId) {
            const rows = await inTx(tx => tx.accountPetPackage.findMany({
                where: {
                    accountId,
                    deletedAt: null,
                },
                orderBy: [
                    { updatedAt: "desc" },
                    { id: "asc" },
                ],
                include: {
                    assets: {
                        orderBy: { createdAt: "asc" },
                        take: 1,
                    },
                },
            }), { readOnly: true });
            return mapRows(rows);
        },
        async readAccountPet(accountId, petId) {
            const row = await inTx(tx => tx.accountPetPackage.findFirst({
                where: {
                    id: petId,
                    accountId,
                    deletedAt: null,
                },
                include: {
                    assets: {
                        orderBy: { createdAt: "asc" },
                        take: 1,
                    },
                },
            }), { readOnly: true });
            return row ? mapAccountPetRow(row) : null;
        },
        async readAccountPetByDigest(accountId, digest) {
            const row = await inTx(tx => tx.accountPetPackage.findFirst({
                where: { accountId, digest, deletedAt: null },
                include: {
                    assets: { orderBy: { createdAt: "asc" }, take: 1 },
                },
            }), { readOnly: true });
            return row ? mapAccountPetRow(row) : null;
        },
        async deleteAccountPet(accountId, petId) {
            try {
                return await inTx(async (tx): Promise<DeletePersistedAccountPetResult> => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, "serializing");
                    const row = await tx.accountPetPackage.findFirst({
                        where: {
                            id: petId,
                            accountId,
                            deletedAt: null,
                        },
                    });
                    if (!row) {
                        return { ok: false, error: "not-found" };
                    }

                    const deletedAtDate = new Date();
                    const deletedAt = deletedAtDate.getTime();
                    await tx.accountPetPackage.update({
                        where: { id: petId },
                        data: {
                            deletedAt: deletedAtDate,
                            updatedAt: deletedAtDate,
                            version: { increment: 1 },
                        },
                    });
                    await markAccountChanged(tx, {
                        accountId,
                        kind: "pet",
                        entityId: petId,
                        hint: {
                            domain: "accountPet",
                            action: "delete",
                            accountPetId: petId,
                            changedAt: deletedAt,
                        },
                    });

                    return {
                        ok: true,
                        deletedAt,
                    };
                });
            } catch {
                return { ok: false, error: "internal" };
            }
        },
    };
}

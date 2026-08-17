import type { Prisma } from "@prisma/client";

import {
    AccountPetOriginV1Schema,
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    PetAssetMediaTypeV1Schema,
    PetPackageManifestV1Schema,
    type AccountPetLibraryEntryV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

export type PersistedAccountPet = Readonly<{
    accountId: string;
    accountPetId: string;
    contentMode: string;
    entry: AccountPetLibraryEntryV1 | null;
    asset: {
        contentMode: string;
        objectKey: string;
    } | null;
}>;

export type PersistAccountPetParams = Readonly<{
    accountId: string;
    entry: AccountPetLibraryEntryV1;
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
    | Readonly<{ ok: false; error: "plaintext-required" | "quota-exceeded" | "internal" }>;

export type AccountPetLibraryPersistence = Readonly<{
    persistAccountPet(params: PersistAccountPetParams & { quotaLimits: AccountPetQuotaLimits }): Promise<PersistAccountPetResult>;
    listAccountPets(accountId: string): Promise<PersistedAccountPet[]>;
    readAccountPet(accountId: string, petId: string): Promise<PersistedAccountPet | null>;
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
    const manifest = PetPackageManifestV1Schema.safeParse(row.manifest);
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

    return {
        accountId: row.accountId,
        accountPetId: row.id,
        contentMode: row.contentMode,
        entry: {
            accountPetId: row.id,
            packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
            manifest: manifest.data,
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
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId);
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
                    if (
                        !accountCurrentness
                        || accountCurrentness.status !== "ready"
                        || accountCurrentness.currentness.encryptionMode !== "plain"
                    ) {
                        return { ok: false, error: "plaintext-required" };
                    }

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
                            id: params.entry.accountPetId,
                            accountId: params.accountId,
                            packageFormat: params.entry.packageFormat,
                            contentMode: "plain",
                            manifest: toPrismaJson(params.entry.manifest),
                            digest: params.entry.digest,
                            sizeBytes: params.entry.sizeBytes,
                            origin: toPrismaJson(params.entry.origin),
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
                            contentMode: "plain",
                            storageKind: "privateFile",
                            objectKey: params.objectKey,
                            byteLength: params.entry.spritesheetAssetRef.sizeBytes,
                            mediaType: params.entry.spritesheetAssetRef.mediaType,
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
            const rows = await db.accountPetPackage.findMany({
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
            });
            return mapRows(rows);
        },
        async readAccountPet(accountId, petId) {
            const row = await db.accountPetPackage.findFirst({
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
            });
            return row ? mapAccountPetRow(row) : null;
        },
        async deleteAccountPet(accountId, petId) {
            try {
                return await inTx(async (tx): Promise<DeletePersistedAccountPetResult> => {
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

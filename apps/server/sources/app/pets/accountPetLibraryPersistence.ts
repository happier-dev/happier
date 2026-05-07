import type { Prisma } from "@prisma/client";

import {
    AccountPetOriginV1Schema,
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    PetAssetMediaTypeV1Schema,
    PetPackageManifestV1Schema,
    type AccountPetLibraryEntryV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

export type PersistedAccountPet = Readonly<{
    accountId: string;
    entry: AccountPetLibraryEntryV1;
    asset: {
        objectKey: string;
    };
}>;

export type PersistAccountPetParams = Readonly<{
    accountId: string;
    entry: AccountPetLibraryEntryV1;
    objectKey: string;
    maxImportedPetsPerAccount?: number;
    maxImportedPetBytesPerAccount?: number;
}>;

export type DeletePersistedAccountPetResult =
    | Readonly<{
        ok: true;
        deletedAt: number;
        objectKeys: string[];
    }>
    | Readonly<{ ok: false; error: "not-found" | "internal" }>;

export type AccountPetLibraryPersistence = Readonly<{
    persistAccountPet(params: PersistAccountPetParams): Promise<void>;
    listAccountPets(accountId: string): Promise<PersistedAccountPet[]>;
    readAccountPet(accountId: string, petId: string): Promise<PersistedAccountPet | null>;
    deleteAccountPet(accountId: string, petId: string): Promise<DeletePersistedAccountPetResult>;
}>;

export class AccountPetQuotaExceededError extends Error {
    constructor() {
        super("account pet quota exceeded");
        this.name = "AccountPetQuotaExceededError";
    }
}

export function isAccountPetQuotaExceededError(error: unknown): error is AccountPetQuotaExceededError {
    return error instanceof AccountPetQuotaExceededError;
}

type AccountPetAssetRow = Readonly<{
    id: string;
    objectKey: string;
    byteLength: number;
    mediaType: string;
    digest: string;
}>;

type AccountPetPackageRow = Readonly<{
    id: string;
    accountId: string;
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

function mapAccountPetRow(row: AccountPetPackageRow): PersistedAccountPet | null {
    const asset = row.assets[0];
    if (!asset || row.packageFormat !== PET_PACKAGE_FORMAT_CODEX_ATLAS_V1) {
        return null;
    }

    const mediaType = PetAssetMediaTypeV1Schema.safeParse(asset.mediaType);
    const manifest = PetPackageManifestV1Schema.safeParse(row.manifest);
    const origin = AccountPetOriginV1Schema.safeParse(row.origin);
    if (!mediaType.success || !manifest.success || !origin.success) {
        return null;
    }

    return {
        accountId: row.accountId,
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
        asset: {
            objectKey: asset.objectKey,
        },
    };
}

function compactRows(rows: AccountPetPackageRow[]): PersistedAccountPet[] {
    return rows.flatMap((row) => {
        const mapped = mapAccountPetRow(row);
        return mapped ? [mapped] : [];
    });
}

export function createPrismaAccountPetLibraryPersistence(): AccountPetLibraryPersistence {
    return {
        async persistAccountPet(params) {
            await inTx(async (tx) => {
                await tx.account.update({
                    where: { id: params.accountId },
                    data: { updatedAt: new Date() },
                    select: { id: true },
                });

                const existing = await tx.accountPetPackage.aggregate({
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
                if (
                    typeof params.maxImportedPetsPerAccount === "number"
                    && existing._count._all >= params.maxImportedPetsPerAccount
                ) {
                    throw new AccountPetQuotaExceededError();
                }

                const existingBytes = existing._sum.sizeBytes ?? 0;
                if (
                    typeof params.maxImportedPetBytesPerAccount === "number"
                    && existingBytes + params.entry.sizeBytes > params.maxImportedPetBytesPerAccount
                ) {
                    throw new AccountPetQuotaExceededError();
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
            });
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
            return compactRows(rows);
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
                        include: {
                            assets: {
                                select: {
                                    objectKey: true,
                                },
                            },
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
                        objectKeys: row.assets.map((asset) => asset.objectKey),
                    };
                });
            } catch {
                return { ok: false, error: "internal" };
            }
        },
    };
}

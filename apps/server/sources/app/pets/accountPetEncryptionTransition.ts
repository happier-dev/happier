import type { Tx } from "@/storage/inTx";

export type AccountPetEncryptionTransitionInventory =
    | Readonly<{ status: "empty" }>
    | Readonly<{
        status: "not_empty";
        livePackageCount: number;
        liveAssetCount: number;
    }>;

export async function assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountPetEncryptionTransitionInventory> {
    const livePackageCount = await tx.accountPetPackage.count({
        where: {
            accountId,
            deletedAt: null,
        },
    });
    const liveAssetCount = await tx.accountPetAsset.count({
        where: {
            accountId,
            petPackage: {
                deletedAt: null,
            },
        },
    });

    if (livePackageCount === 0 && liveAssetCount === 0) {
        return { status: "empty" };
    }

    return {
        status: "not_empty",
        livePackageCount,
        liveAssetCount,
    };
}

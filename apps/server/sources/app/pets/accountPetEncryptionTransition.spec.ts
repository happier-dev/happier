import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import {
    assertAccountPetLibraryEmptyForEncryptionTransitionInTx,
} from "./accountPetEncryptionTransition";

function createTx(params: {
    livePackageCount: number;
    liveAssetCount: number;
}) {
    return {
        accountPetPackage: {
            count: vi.fn(async () => params.livePackageCount),
        },
        accountPetAsset: {
            count: vi.fn(async () => params.liveAssetCount),
        },
    };
}

describe("assertAccountPetLibraryEmptyForEncryptionTransitionInTx", () => {
    it("returns empty only when the Account has no live package or asset", async () => {
        const tx = createTx({
            livePackageCount: 0,
            liveAssetCount: 0,
        });

        await expect(
            assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                tx as unknown as Tx,
                "account-1",
            ),
        ).resolves.toEqual({ status: "empty" });
        expect(tx.accountPetPackage.count).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: null,
            },
        });
        expect(tx.accountPetAsset.count).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                petPackage: {
                    deletedAt: null,
                },
            },
        });
    });

    it.each([
        {
            livePackageCount: 1,
            liveAssetCount: 0,
        },
        {
            livePackageCount: 1,
            liveAssetCount: 1,
        },
        {
            livePackageCount: 0,
            liveAssetCount: 1,
        },
    ])(
        "returns exact non-empty inventory without mutating rows for package=$livePackageCount asset=$liveAssetCount",
        async ({ livePackageCount, liveAssetCount }) => {
            const tx = createTx({
                livePackageCount,
                liveAssetCount,
            });

            await expect(
                assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                    tx as unknown as Tx,
                    "account-1",
                ),
            ).resolves.toEqual({
                status: "not_empty",
                livePackageCount,
                liveAssetCount,
            });
        },
    );
});

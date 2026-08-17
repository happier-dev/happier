import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findAccount: vi.fn(),
    listAccountPetsForAccount: vi.fn(),
    readAccountPetAssetForAccount: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: mocks.findAccount,
        },
    },
}));

vi.mock("./accountPetLibraryRuntime", () => ({
    getDefaultAccountPetLibraryServices: () => ({
        listAccountPetsForAccount: mocks.listAccountPetsForAccount,
        readAccountPetAssetForAccount: mocks.readAccountPetAssetForAccount,
    }),
}));

describe("accountPetLibraryReadService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        "e2ee",
        "future-mode",
    ])("fails closed for persisted Account mode %s before reading pets", async (encryptionMode) => {
        mocks.findAccount.mockResolvedValue({
            encryptionMode,
            publicKey: null,
        });
        const { listAccountPetsForAccount, readAccountPetAssetForAccount } = await import(
            "./accountPetLibraryReadService"
        );

        await expect(listAccountPetsForAccount({
            accountId: "account-1",
        })).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        await expect(readAccountPetAssetForAccount({
            accountId: "account-1",
            petId: "pet-1",
            assetId: "asset-1",
        })).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        expect(mocks.listAccountPetsForAccount).not.toHaveBeenCalled();
        expect(mocks.readAccountPetAssetForAccount).not.toHaveBeenCalled();
    });

    it("returns typed unavailable for a missing Account instead of an empty list or not found asset", async () => {
        mocks.findAccount.mockResolvedValue(null);
        const { listAccountPetsForAccount, readAccountPetAssetForAccount } = await import(
            "./accountPetLibraryReadService"
        );

        await expect(listAccountPetsForAccount({
            accountId: "missing-account",
        })).resolves.toMatchObject({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
        });
        await expect(readAccountPetAssetForAccount({
            accountId: "missing-account",
            petId: "pet-1",
            assetId: null,
        })).resolves.toMatchObject({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
        });
    });

    it("passes the canonical persisted plain mode into the domain service", async () => {
        mocks.findAccount.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: "retained-public-key",
        });
        mocks.listAccountPetsForAccount.mockResolvedValue({ ok: true, pets: [] });
        const { listAccountPetsForAccount } = await import(
            "./accountPetLibraryReadService"
        );

        await expect(listAccountPetsForAccount({
            accountId: "account-1",
        })).resolves.toEqual({ ok: true, pets: [] });
        expect(mocks.listAccountPetsForAccount).toHaveBeenCalledWith({
            accountId: "account-1",
            accountEncryptionMode: "plain",
        });
    });
});

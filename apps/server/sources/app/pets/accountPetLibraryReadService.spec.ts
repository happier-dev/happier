import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findAccount: vi.fn(),
    listPets: vi.fn(),
    findPet: vi.fn(),
}));

// Only the persistent database boundary is replaced; Account mode, runtime,
// domain service and persistence mapping stay real beneath it.
vi.mock("@/storage/db", () => {
    const reader = {
        account: { findUnique: mocks.findAccount },
        accountPetPackage: { findMany: mocks.listPets, findFirst: mocks.findPet },
    };
    return { db: { ...reader, $transaction: async (read: (tx: typeof reader) => Promise<unknown>) => await read(reader) } };
});

describe("accountPetLibraryReadService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("HAPPIER_DB_PROVIDER", "postgres");
        mocks.listPets.mockResolvedValue([]);
        mocks.findPet.mockResolvedValue(null);
    });
    afterEach(() => { vi.unstubAllEnvs(); });

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
        expect(mocks.listPets).not.toHaveBeenCalled();
        expect(mocks.findPet).not.toHaveBeenCalled();
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

    it("reads the real empty library from canonical persisted plain mode", async () => {
        mocks.findAccount.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: "retained-public-key",
        });
        const { listAccountPetsForAccount } = await import(
            "./accountPetLibraryReadService"
        );

        await expect(listAccountPetsForAccount({
            accountId: "account-1",
        })).resolves.toEqual({ ok: true, pets: [] });
    });
});

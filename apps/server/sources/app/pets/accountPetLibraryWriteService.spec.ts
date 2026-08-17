import { describe, expect, it, vi } from "vitest";

const { findAccount } = vi.hoisted(() => ({
    findAccount: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: findAccount,
        },
    },
}));

import { createAccountPetForAccount } from "./accountPetLibraryWriteService";

describe("accountPetLibraryWriteService", () => {
    it("rejects inconsistent E2EE before pet validation or provisioning", async () => {
        findAccount.mockResolvedValueOnce({
            publicKey: null,
            encryptionMode: "e2ee",
            contentPublicKey: null,
            contentPublicKeySig: null,
        });

        await expect(createAccountPetForAccount({
            accountId: "account-1",
            request: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        });
    });
});

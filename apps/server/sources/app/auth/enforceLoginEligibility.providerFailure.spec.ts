import { describe, expect, it, vi } from "vitest";

import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";

const dbAccountFindUnique = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: any[]) => dbAccountFindUnique(...args),
        },
    },
}));

const isAccountDisabled = vi.fn();
vi.mock("@/app/auth/accountDisable", () => ({
    isAccountDisabled: (...args: any[]) => isAccountDisabled(...args),
}));

const resolveAuthPolicyFromEnv = vi.fn();
vi.mock("@/app/auth/authPolicy", () => ({
    resolveAuthPolicyFromEnv: (...args: any[]) => resolveAuthPolicyFromEnv(...args),
}));

const findIdentityProviderById = vi.fn();
vi.mock("@/app/auth/providers/identityProviders/registry", () => ({
    findIdentityProviderById: (...args: any[]) => findIdentityProviderById(...args),
}));

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

describe("enforceLoginEligibility (provider failures)", () => {
    it("fails closed with upstream_error when a required provider enforcement throws", async () => {
        dbAccountFindUnique.mockResolvedValueOnce({ id: "acct-1" });
        isAccountDisabled.mockResolvedValueOnce(false);
        resolveAuthPolicyFromEnv.mockReturnValueOnce({ requiredLoginProviders: ["github"] });
        findIdentityProviderById.mockReturnValueOnce({
            id: "github",
            enforceLoginEligibility: async () => {
                throw new Error("provider down");
            },
        });

        await expect(
            enforceLoginEligibility({ accountId: "acct-1", env: {} }),
        ).resolves.toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
    });
});

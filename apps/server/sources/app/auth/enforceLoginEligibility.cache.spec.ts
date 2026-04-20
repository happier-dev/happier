import { beforeEach, describe, expect, it, vi } from "vitest";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    },
}));

const isAccountDisabledMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/accountDisable", () => ({
    isAccountDisabled: (...args: unknown[]) => isAccountDisabledMock(...args),
}));

const resolveAuthPolicyFromEnvMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/authPolicy", () => ({
    resolveAuthPolicyFromEnv: (...args: unknown[]) => resolveAuthPolicyFromEnvMock(...args),
}));

const findIdentityProviderByIdMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/providers/identityProviders/registry", () => ({
    findIdentityProviderById: (...args: unknown[]) => findIdentityProviderByIdMock(...args),
}));

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

async function importEnforceLoginEligibility() {
    const module = await import("./enforceLoginEligibility");
    return module.enforceLoginEligibility;
}

describe("enforceLoginEligibility cache", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        resolveAuthPolicyFromEnvMock.mockReturnValue({ requiredLoginProviders: [] });
        findIdentityProviderByIdMock.mockReset();
        isAccountDisabledMock.mockResolvedValue(false);
        dbAccountFindUniqueMock.mockResolvedValue({ id: "acct-1" });
    });

    it("coalesces concurrent same-account checks and reuses the hot positive result", async () => {
        let releaseLookup: (() => void) | null = null;
        dbAccountFindUniqueMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseLookup = () => resolve({ id: "acct-1" });
                }),
        );

        const enforceLoginEligibility = await importEnforceLoginEligibility();

        const first = enforceLoginEligibility({ accountId: "acct-1", env: {} });
        const second = enforceLoginEligibility({ accountId: "acct-1", env: {} });

        expect(dbAccountFindUniqueMock).toHaveBeenCalledTimes(1);
        const release = releaseLookup as (() => void) | null;
        if (!release) {
            throw new Error("expected the first lookup to block");
        }
        release();

        await expect(Promise.all([first, second])).resolves.toEqual([
            { ok: true },
            { ok: true },
        ]);

        await expect(enforceLoginEligibility({ accountId: "acct-1", env: {} })).resolves.toEqual({ ok: true });
        expect(dbAccountFindUniqueMock).toHaveBeenCalledTimes(1);
        expect(isAccountDisabledMock).toHaveBeenCalledTimes(1);
    });

    it("does not cache transient upstream failures", async () => {
        dbAccountFindUniqueMock.mockRejectedValueOnce(new Error("db down"));

        const enforceLoginEligibility = await importEnforceLoginEligibility();

        await expect(enforceLoginEligibility({ accountId: "acct-1", env: {} })).resolves.toEqual({
            ok: false,
            statusCode: 503,
            error: "upstream_error",
        });

        dbAccountFindUniqueMock.mockResolvedValueOnce({ id: "acct-1" });

        await expect(enforceLoginEligibility({ accountId: "acct-1", env: {} })).resolves.toEqual({ ok: true });
        expect(dbAccountFindUniqueMock).toHaveBeenCalledTimes(2);
    });

    it("reuses a hot account snapshot even when the final positive-result cache is disabled", async () => {
        const enforceLoginEligibility = await importEnforceLoginEligibility();
        const env = {
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "60000",
        };

        await expect(enforceLoginEligibility({ accountId: "acct-1", env })).resolves.toEqual({ ok: true });
        await expect(enforceLoginEligibility({ accountId: "acct-1", env })).resolves.toEqual({ ok: true });

        expect(dbAccountFindUniqueMock).toHaveBeenCalledTimes(1);
        expect(isAccountDisabledMock).toHaveBeenCalledTimes(1);
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";

const {
    dbAccountFindUnique,
    dbAccountIdentityFindFirst,
    dbIdentityProviderInstanceFindUnique,
    dbTeamIdentityConnectionFindMany,
} = vi.hoisted(() => ({
    dbAccountFindUnique: vi.fn(),
    dbAccountIdentityFindFirst: vi.fn(),
    dbIdentityProviderInstanceFindUnique: vi.fn(),
    dbTeamIdentityConnectionFindMany: vi.fn(),
}));
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    const boundary = {
        ...inTxPostgresControlStatementMock,
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUnique(...args),
        },
        accountIdentity: {
            findFirst: (...args: unknown[]) => dbAccountIdentityFindFirst(...args),
        },
        identityProviderInstance: {
            findUnique: (...args: unknown[]) => dbIdentityProviderInstanceFindUnique(...args),
        },
        teamIdentityConnection: {
            findMany: (...args: unknown[]) => dbTeamIdentityConnectionFindMany(...args),
        },
    };
    const { wrapDb } = createDbTransactionMock(() => boundary);
    return { db: wrapDb(boundary) };
});

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

/**
 * The provider is resolved through the real asynchronous catalog: only the database and logging
 * boundaries are substituted, so a required provider that cannot be resolved or whose enforcement
 * fails must still fail closed.
 */
function envWithDeploymentProvider(): NodeJS.ProcessEnv {
    return {
        AUTH_REQUIRED_LOGIN_PROVIDERS: "acme",
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
        AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
            {
                id: "acme",
                type: "oidc",
                displayName: "Acme",
                issuer: "https://issuer.example.test",
                clientId: "cid",
                clientAuthenticationMethod: "client_secret_post",
                clientSecret: "secret",
                redirectUrl: "https://server.example.test/v1/oauth/acme/callback",
            },
        ]),
    };
}

describe("enforceLoginEligibility (provider failures)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbAccountFindUnique.mockImplementation(async (query: { where: { id: string } }) => ({
            id: query.where.id, status: "active",
        }));
        dbAccountIdentityFindFirst.mockResolvedValue({
            id: "acme-identity",
            providerUserId: "acme-subject",
            providerLogin: "alice",
            profile: { sub: "acme-subject", preferred_username: "alice" },
            token: null,
            eligibilityStatus: "eligible",
            eligibilityCheckedAt: null,
            eligibilityNextCheckAt: null,
        });
        dbIdentityProviderInstanceFindUnique.mockResolvedValue(null);
        dbTeamIdentityConnectionFindMany.mockResolvedValue([]);
    });

    it("fails closed with upstream_error when required provider runtime resolution throws", async () => {
        const env = envWithDeploymentProvider();
        await expect(enforceLoginEligibility({ accountId: "acct-catalog-throws", env }))
            .resolves.toEqual({ ok: true });
        dbIdentityProviderInstanceFindUnique.mockClear();
        dbIdentityProviderInstanceFindUnique.mockRejectedValueOnce(new Error("provider catalog unavailable"));

        await expect(
            enforceLoginEligibility({ accountId: "acct-catalog-throws", env }),
        ).resolves.toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
        expect(dbIdentityProviderInstanceFindUnique).toHaveBeenCalledWith({
            where: { id: "acme" }, select: { id: true },
        });
    });

    it("fails closed with upstream_error when a required provider enforcement throws", async () => {
        const env = envWithDeploymentProvider();
        await expect(enforceLoginEligibility({ accountId: "acct-provider-throws", env }))
            .resolves.toEqual({ ok: true });
        dbAccountIdentityFindFirst.mockClear();
        dbAccountIdentityFindFirst.mockRejectedValueOnce(new Error("provider down"));

        await expect(
            enforceLoginEligibility({ accountId: "acct-provider-throws", env }),
        ).resolves.toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
        expect(dbAccountIdentityFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "acct-provider-throws", provider: "acme" },
        }));
    });

    it("fails closed with upstream_error when a required provider is not in the catalog", async () => {
        const env = envWithDeploymentProvider();
        await expect(enforceLoginEligibility({ accountId: "acct-provider-missing", env }))
            .resolves.toEqual({ ok: true });
        dbTeamIdentityConnectionFindMany.mockClear();

        await expect(
            enforceLoginEligibility({ accountId: "acct-provider-missing", env: { ...env, AUTH_REQUIRED_LOGIN_PROVIDERS: "not-configured" } }),
        ).resolves.toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
        expect(dbTeamIdentityConnectionFindMany).toHaveBeenCalledWith({
            where: { teamId: null, providerInstanceId: "not-configured" },
            select: { id: true },
        });
    });
});

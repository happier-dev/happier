import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { encryptString } from "@/modules/encrypt";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { enforceGitHubLoginEligibility } from "./loginEligibility";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("GitHub login eligibility upstream failures (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-gh-elig-",
            initEncrypt: true,
            initAuth: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    beforeEach(async () => {
        harness.restoreEnv();
        vi.unstubAllGlobals();
        delete process.env.AUTH_GITHUB_ALLOWED_USERS;
        delete process.env.AUTH_GITHUB_ALLOWED_ORGS;
        delete process.env.AUTH_GITHUB_ORG_MATCH;
        delete process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE;
        delete process.env.AUTH_OFFBOARDING_ENABLED;
        delete process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS;
        delete process.env.AUTH_OFFBOARDING_STRICT;

        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    async function createEligibleAccount(params: { now: Date }) {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-eligible` },
            select: { id: true },
        });

        const tokenBytes = encryptString(["user", account.id, "github", "token"], "access-token") as any;

        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "alice",
                token: tokenBytes,
                eligibilityStatus: "eligible",
                eligibilityCheckedAt: new Date(params.now.getTime() - 24 * 60 * 60 * 1000),
                eligibilityNextCheckAt: new Date(params.now.getTime() - 1000),
            },
            select: { id: true },
        });

        return account.id;
    }

    it("fails open in non-strict mode when upstream is down and the user was previously eligible", async () => {
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.AUTH_OFFBOARDING_ENABLED = "true";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "600";

        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("network down");
        }) as any);

        const now = new Date();
        const accountId = await createEligibleAccount({ now });

        const policy = resolveAuthPolicyFromEnv(process.env);
        const res = await enforceGitHubLoginEligibility({ accountId, env: process.env, policy, now });
        expect(res).toEqual({ ok: true });

        const identity = await db.accountIdentity.findFirst({
            where: { accountId, provider: "github" },
            select: { eligibilityStatus: true, eligibilityNextCheckAt: true, eligibilityCheckedAt: true },
        });
        expect(identity?.eligibilityStatus).toBe("eligible");
        expect(identity?.eligibilityCheckedAt?.getTime()).toBe(now.getTime());
        expect(identity?.eligibilityNextCheckAt).toBeTruthy();
        expect((identity?.eligibilityNextCheckAt?.getTime() ?? 0) > now.getTime()).toBe(true);
    });

    it("fails closed in strict mode when upstream is down (even if the user was previously eligible)", async () => {
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.AUTH_OFFBOARDING_ENABLED = "true";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "600";
        process.env.AUTH_OFFBOARDING_STRICT = "true";

        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("network down");
        }) as any);

        const now = new Date();
        const accountId = await createEligibleAccount({ now });

        const policy = resolveAuthPolicyFromEnv(process.env);
        const res = await enforceGitHubLoginEligibility({ accountId, env: process.env, policy, now });
        expect(res).toEqual({ ok: false, statusCode: 403, error: "not-eligible" });
    });

    it("does not allow bypassing org restrictions when upstream is down and eligibility is unknown", async () => {
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.AUTH_OFFBOARDING_ENABLED = "true";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "600";

        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("network down");
        }) as any);

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-unknown` },
            select: { id: true },
        });

        const tokenBytes = encryptString(["user", account.id, "github", "token"], "access-token") as any;
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "999",
                providerLogin: "alice",
                token: tokenBytes,
                eligibilityStatus: "unknown",
                eligibilityCheckedAt: null,
                eligibilityNextCheckAt: new Date(0),
            },
            select: { id: true },
        });

        const now = new Date();
        const policy = resolveAuthPolicyFromEnv(process.env);
        const res = await enforceGitHubLoginEligibility({ accountId: account.id, env: process.env, policy, now });
        expect(res).toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
    });
});

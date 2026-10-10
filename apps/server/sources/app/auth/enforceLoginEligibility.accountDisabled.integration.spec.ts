import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import * as privacyKit from "privacy-kit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("enforceLoginEligibility (account disabled)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-eligibility-disabled-",
            initEncrypt: true,
            env: {
                // Ensure no providers are required for eligibility (this is the case we want to cover).
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("blocks a disabled account even when no providers are required", async () => {
        const publicKey = privacyKit.encodeHex(new Uint8Array(32).fill(8));
        const account = await db.account.create({ data: { publicKey }, select: { id: true } });

        await db.account.update({ where: { id: account.id }, data: { status: "disabled" } });

        const out = await enforceLoginEligibility({ accountId: account.id, env: process.env });
        expect(out).toEqual({ ok: false, statusCode: 403, error: "account-disabled" });
    });

    it.each(["1000", "0"])("does not let cached eligibility hide disablement (positive TTL %s)", async (ttl) => {
        const account = await db.account.create({ data: { publicKey: `eligibility-disable-cache-${ttl}` } });
        const env = { ...process.env, AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: ttl };
        await expect(enforceLoginEligibility({ accountId: account.id, env })).resolves.toEqual({ ok: true });

        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });

        await expect(enforceLoginEligibility({ accountId: account.id, env })).resolves.toEqual({
            ok: false, statusCode: 403, error: "account-disabled",
        });
    });

    it("does not let cached eligibility authenticate an erased Account", async () => {
        const account = await db.account.create({ data: { publicKey: "eligibility-erased-cache" } });
        await expect(enforceLoginEligibility({ accountId: account.id, env: process.env })).resolves.toEqual({ ok: true });
        await db.account.delete({ where: { id: account.id } });

        await expect(enforceLoginEligibility({ accountId: account.id, env: process.env })).resolves.toEqual({
            ok: false, statusCode: 401, error: "invalid-token",
        });
    });

});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { disableAccount } from "@/app/auth/accountDisable";
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

        await disableAccount({ accountId: account.id, reason: "test", env: process.env });

        const out = await enforceLoginEligibility({ accountId: account.id, env: process.env });
        expect(out).toEqual({ ok: false, statusCode: 403, error: "account-disabled" });
    });

    it("fails closed when the account-disabled check cannot query the database", async () => {
        const publicKey = privacyKit.encodeHex(new Uint8Array(32).fill(9));
        const account = await db.account.create({ data: { publicKey }, select: { id: true } });

        const spy = vi.spyOn(db.repeatKey, "findUnique").mockRejectedValueOnce(new Error("disk I/O error"));
        try {
            const out = await enforceLoginEligibility({ accountId: account.id, env: process.env });
            expect(out).toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
        } finally {
            spy.mockRestore();
        }
    });

    it("fails closed when the account lookup cannot query the database", async () => {
        const spy = vi.spyOn(db.account, "findUnique").mockRejectedValueOnce(new Error("disk I/O error"));
        try {
            const out = await enforceLoginEligibility({ accountId: "cmnx-test", env: process.env });
            expect(out).toEqual({ ok: false, statusCode: 503, error: "upstream_error" });
        } finally {
            spy.mockRestore();
        }
    });
});

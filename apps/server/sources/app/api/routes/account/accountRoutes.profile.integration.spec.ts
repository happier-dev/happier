import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

describe("Account profile (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-profile-", initAuth: false });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("GET /v1/account/profile returns linkedProviders derived from AccountIdentity", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-gh" },
                    select: { id: true },
                });

                const githubProfile = { id: 123, login: "octocat", avatar_url: "x", name: "Octo Cat" };
                await db.accountIdentity.create({
                    data: {
                        accountId: account.id,
                        provider: "github",
                        providerUserId: "123",
                        providerLogin: "octocat",
                        profile: githubProfile as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.github).toBeUndefined();
                expect(body.linkedProviders).toEqual([
                    {
                        id: "github",
                        login: "octocat",
                        displayName: "Octo Cat",
                        avatarUrl: "x",
                        profileUrl: "https://github.com/octocat",
                        showOnProfile: true,
                    },
                ]);
            },
        );
    });
});

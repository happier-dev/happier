import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

describe("Account identity visibility (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-identity-", initAuth: false });
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
            () => db.accountChange.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("PATCH /v1/account/identity/:provider updates showOnProfile and reflects in /v1/account/profile", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-identity-visibility" },
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

                const updateRes = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/identity/github",
                    headers: { "x-test-user-id": account.id },
                    payload: { showOnProfile: false },
                });

                expect(updateRes.statusCode).toBe(200);
                expect(updateRes.json()).toEqual({ success: true });

                const change = await db.accountChange.findFirst({
                    where: { accountId: account.id, kind: "account", entityId: "self" },
                    select: { cursor: true },
                });
                expect(change).toBeTruthy();
                expect(typeof change?.cursor).toBe("number");

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });
                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.linkedProviders).toEqual([
                    {
                        id: "github",
                        login: "octocat",
                        displayName: "Octo Cat",
                        avatarUrl: "x",
                        profileUrl: "https://github.com/octocat",
                        showOnProfile: false,
                    },
                ]);
            },
        );
    });
});

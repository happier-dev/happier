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

    it("GET /v1/account/profile includes connectedServicesV2 with per-profile status", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2" },
                    select: { id: true },
                });

                // Legacy token (v1) stored under the same service id but without v2 metadata.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "anthropic",
                        profileId: "default",
                        token: Buffer.from("legacy", "utf8"),
                        metadata: null,
                    },
                });

                // Sealed v2 record (ciphertext bytes + v2 metadata only; server never decrypts).
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth", providerEmail: "user@example.com" } as any,
                        expiresAt: new Date(Date.now() + 3600_000),
                    },
                });

                // Legacy vendor token for OpenAI (not a connected service id) should not appear in connectedServicesV2.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(Array.isArray(body.connectedServicesV2)).toBe(true);
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        profiles: [
                            expect.objectContaining({
                                profileId: "work",
                                status: "connected",
                                providerEmail: "user@example.com",
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "anthropic",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                                status: "needs_reauth",
                            }),
                        ],
                    }),
                ]));
                expect(body.connectedServicesV2).toEqual(
                    expect.not.arrayContaining([
                        expect.objectContaining({
                            serviceId: "openai",
                        }),
                    ]),
                );
            },
        );
    });

    it("GET /v1/account/profile returns empty connectedServices + connectedServicesV2 when connected services feature is disabled", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = "0";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2-disabled" },
                    select: { id: true },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.connectedServices).toEqual([]);
                expect(body.connectedServicesV2).toEqual([]);
            },
        );
    });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerOAuthCallbackRoute } from "@/app/api/routes/connect/oauthExternal/registerOAuthCallbackRoute";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("Cloud supporter perks on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-perks-",
            initAuth: true,
            env: {
                POLAR_ACCESS_TOKEN: "polar-test",
                GITHUB_CLIENT_ID: "github-test",
                GITHUB_CLIENT_SECRET: "github-test-secret",
                GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
                HAPPIER_FEATURE_SUPPORTER__ENABLED: "true",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("claims an inactive one-time sponsorship and publishes only consented public facts", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const github = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/login/oauth/access_token") return Response.json({ access_token: "github-user-token" });
            if (path === "/user") return Response.json({ id: 41, login: "SponsorOne" });
            if (path === "/graphql") {
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-user-token");
                const { query, variables } = JSON.parse(String(init?.body));
                const includesInactive = /sponsorshipsAsSponsor\([^)]*activeOnly:\s*false/.test(query);
                const qualifyingPage = includesInactive && variables?.maintainers?.includes("leeroybrun");
                const firstPage = qualifyingPage && variables.after === null;
                return Response.json({ data: {
                    viewer: { login: "SponsorOne", sponsorshipsAsSponsor: {
                        nodes: qualifyingPage && variables.after === "next-page"
                            ? [{ isActive: false, isOneTimePayment: true, sponsorable: { login: "leeroybrun" } }]
                            : [],
                        pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? "next-page" : null },
                    } },
                } });
            }
            throw new Error(`Unexpected GitHub request: ${path}`);
        });
        try {
            await withAuthenticatedTestApp((app) => {
                billingRoutes(app);
                registerOAuthCallbackRoute(app);
            }, async (app) => {
                const headers = { "x-test-user-id": account.id };
                const start = await app.inject({
                    method: "POST", url: "/v1/supporter/github/start", headers, payload: { publishGitHubLogin: true },
                });
                expect(start.statusCode).toBe(200);
                const state = new URL(start.json().url).searchParams.get("state");
                expect(state).toBeTruthy();
                const callback = await app.inject({ url: `/v1/oauth/github/callback?code=test&state=${encodeURIComponent(state ?? "")}` });
                expect(new URL(callback.headers.location).searchParams.get("linked")).toBe("sponsor");

                const record = await db.supporterRecord.findUniqueOrThrow({ where: { accountId: account.id } });
                expect(record.kind).toBe("github_sponsor");
                expect(record.number).toBeGreaterThan(0);
                const patch = await app.inject({
                    method: "PATCH", url: "/v1/supporter/profile", headers,
                    payload: { publicName: "Sponsor One", publicLink: "https://example.test" },
                });
                expect(patch.statusCode).toBe(200);
                const readWall = async () => {
                    const response = await app.inject({ url: "/v1/supporters/public" });
                    expect(response.statusCode).toBe(200);
                    return response.json();
                };
                expect(await readWall()).toEqual({
                    total: 1,
                    entries: [{ number: record.number, name: "Sponsor One", link: "https://example.test", since: record.grantedAt?.getUTCFullYear() }],
                    githubLabels: ["sponsorone"],
                });
                await db.supporterRecord.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
                expect(await readWall()).toEqual({ total: 0, entries: [], githubLabels: [] });
            });
        } finally {
            github.mockRestore();
        }
    });

    it("keeps sponsorship claims idempotent and leaves the GitHub login private without consent", async () => {
        const sponsor = await db.account.create({ data: { publicKey: randomUUID() } });
        const other = await db.account.create({ data: { publicKey: randomUUID() } });
        let result: "sponsor" | "none" | "error" = "sponsor";
        const github = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === "/login/oauth/access_token") return Response.json({ access_token: "github-user-token" });
            if (path === "/user") return Response.json({ id: 42, login: "PrivateSponsor" });
            if (path !== "/graphql") throw new Error(`Unexpected GitHub request: ${path}`);
            if (result === "error") return new Response(null, { status: 502 });
            return Response.json({ data: {
                viewer: { login: "PrivateSponsor", sponsorshipsAsSponsor: {
                    nodes: result === "sponsor"
                        ? [{ isActive: true, isOneTimePayment: false, sponsorable: { login: "happier-dev" } }]
                        : [
                            { isActive: false, isOneTimePayment: false, sponsorable: { login: "happier-dev" } },
                            { isActive: false, isOneTimePayment: true, sponsorable: { login: "other-maintainer" } },
                        ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                } },
            } });
        });
        try {
            await withAuthenticatedTestApp((app) => {
                billingRoutes(app);
                registerOAuthCallbackRoute(app);
            }, async (app) => {
                const claim = async (accountId: string) => {
                    const start = await app.inject({
                        method: "POST", url: "/v1/supporter/github/start",
                        headers: { "x-test-user-id": accountId }, payload: {},
                    });
                    expect(start.statusCode).toBe(200);
                    const state = new URL(start.json().url).searchParams.get("state");
                    const callback = await app.inject({ url: `/v1/oauth/github/callback?code=test&state=${encodeURIComponent(state ?? "")}` });
                    return new URL(callback.headers.location).searchParams.get("linked");
                };
                expect(await claim(sponsor.id)).toBe("sponsor");
                const first = await db.supporterRecord.findUniqueOrThrow({ where: { accountId: sponsor.id } });
                expect(first.githubLogin).toBeNull();
                expect(await claim(sponsor.id)).toBe("sponsor");
                expect(await db.supporterRecord.findUniqueOrThrow({ where: { accountId: sponsor.id } })).toEqual(first);
                result = "none";
                expect(await claim(other.id)).toBe("none");
                result = "error";
                expect(await claim(other.id)).toBe("error");
                expect(await db.supporterRecord.findUnique({ where: { accountId: other.id } })).toBeNull();
            });
        } finally {
            github.mockRestore();
        }
    });
});

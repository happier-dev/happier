import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerOAuthCallbackRoute } from "@/app/api/routes/connect/oauthExternal/registerOAuthCallbackRoute";
import { auth } from "@/app/auth/auth";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { githubHttp } = vi.hoisted(() => ({ githubHttp: vi.fn() }));
// Keep the production GitHub endpoint policy and OAuth exchange. Stub only DNS and HTTP I/O.
vi.mock("node:dns/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:dns/promises")>();
    return { ...actual, lookup: (host: string, options: never) =>
        host === "github.com" || host === "api.github.com"
            ? Promise.resolve([{ address: "140.82.112.4", family: 4 }])
            : actual.lookup(host, options) };
});
vi.mock("undici/index.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("undici/index.js")>(), fetch: githubHttp,
}));

const cloudEnv = {
    POLAR_ACCESS_TOKEN: "polar-test",
    GITHUB_CLIENT_ID: "github-test",
    GITHUB_CLIENT_SECRET: "github-test-secret",
    GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
    HAPPIER_FEATURE_SUPPORTER__ENABLED: "true",
};
const realAuth = { authentication: "real" } as const;

async function createSupporterAccount() {
    const { id } = await db.account.create({ data: { publicKey: randomUUID() } });
    const token = await auth.createToken(id, undefined, { kind: "account", authority: "present_user" });
    return { id, headers: { authorization: `Bearer ${token}` } };
}

function registerCloudRoutes(app: Parameters<typeof billingRoutes>[0]) {
    billingRoutes(app);
    registerOAuthCallbackRoute(app);
}

type GitHubNode = Readonly<{ isActive: boolean; isOneTimePayment: boolean; sponsorable: { login: string } }>;
function mockGitHub(readPage: (after: string | null) => Readonly<{ nodes: GitHubNode[]; next?: string }> | null) {
    githubHttp.mockImplementation(async (input: URL, init?: RequestInit) => {
        if (input.origin === "https://github.com" && input.pathname === "/login/oauth/access_token") {
            return Response.json({ access_token: "github-user-token" });
        }
        if (input.origin !== "https://api.github.com") throw new Error(`Unexpected GitHub origin: ${input.origin}`);
        if (input.pathname === "/user") return Response.json({ id: 41, login: "SponsorOne" });
        if (input.pathname !== "/graphql") throw new Error(`Unexpected GitHub request: ${input.pathname}`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-user-token");
        const { query, variables } = JSON.parse(String(init?.body));
        expect(query).toMatch(/sponsorshipsAsSponsor\([^)]*activeOnly:\s*false/);
        expect(variables.maintainers).toEqual(["happier-dev", "leeroybrun"]);
        const page = readPage(variables.after);
        if (!page) return new Response(null, { status: 502 });
        return Response.json({ data: {
            viewer: { login: "SponsorOne", sponsorshipsAsSponsor: {
                nodes: page.nodes,
                pageInfo: { hasNextPage: page.next !== undefined, endCursor: page.next ?? null },
            } },
        } });
    });
}

describe("Cloud supporter perks on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-perks-",
            initAuth: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    beforeEach(async () => {
        harness.resetEnv(cloudEnv);
        githubHttp.mockReset();
        await db.supporterRecord.deleteMany();
    });

    it("claims a completed one-time sponsorship and publishes only consented public facts", async () => {
        mockGitHub((after) => after === null
            ? { nodes: [], next: "next-page" }
            : { nodes: [{ isActive: false, isOneTimePayment: true, sponsorable: { login: "leeroybrun" } }] });
        const { id, headers } = await createSupporterAccount();
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const start = await app.inject({
                method: "POST", url: "/v1/supporter/github/start", headers, payload: { publishGitHubLogin: true },
            });
            expect(start.statusCode).toBe(200);
            const authorize = new URL(start.json().url);
            expect(authorize.searchParams.get("scope")?.split(" ")).toContain("read:user");
            const state = authorize.searchParams.get("state");
            expect(state).toBeTruthy();
            const callbackUrl = `/v1/oauth/github/callback?code=test&state=${encodeURIComponent(state ?? "")}`;
            const callback = await app.inject({ url: callbackUrl });
            expect(new URL(callback.headers.location).searchParams.get("linked")).toBe("sponsor");

            const record = await db.supporterRecord.findUniqueOrThrow({ where: { accountId: id } });
            expect(record.kind).toBe("github_sponsor");
            expect(record.number).toBeGreaterThan(0);
            const profile = { publicName: "Sponsor\u0007 One", publicLink: "https://example.test" };
            const patch = await app.inject({ method: "PATCH", url: "/v1/supporter/profile", headers, payload: profile });
            expect(patch.statusCode).toBe(200);
            expect(patch.json()).toEqual({ ok: true });

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
            const withdraw = await app.inject({
                method: "PATCH", url: "/v1/supporter/profile", headers, payload: { githubLogin: null },
            });
            expect(withdraw.statusCode).toBe(200);
            expect(new URL((await app.inject({ url: callbackUrl })).headers.location).searchParams.get("error")).toBe("invalid_state");
            expect((await readWall()).githubLabels).toEqual([]);

            await db.supporterRecord.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
            expect(await readWall()).toEqual({ total: 0, entries: [], githubLabels: [] });
            expect((await app.inject({ method: "PATCH", url: "/v1/supporter/profile", headers, payload: profile })).statusCode).toBe(404);
            expect((await app.inject({ method: "POST", url: "/v1/supporter/github/start", headers, payload: {} })).statusCode).toBe(404);
        }, realAuth);
    });

    it("keeps recurring sponsorship claims idempotent and leaves the GitHub login private without consent", async () => {
        const sponsor = await createSupporterAccount();
        const other = await createSupporterAccount();
        mockGitHub(() => ({ nodes: [{ isActive: true, isOneTimePayment: false, sponsorable: { login: "happier-dev" } }] }));
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const claim = async (headers: Record<string, string>) => {
                const start = await app.inject({ method: "POST", url: "/v1/supporter/github/start", headers, payload: {} });
                expect(start.statusCode).toBe(200);
                const state = new URL(start.json().url).searchParams.get("state");
                const callback = await app.inject({ url: `/v1/oauth/github/callback?code=test&state=${encodeURIComponent(state ?? "")}` });
                return new URL(callback.headers.location).searchParams.get("linked");
            };
            expect(await claim(sponsor.headers)).toBe("sponsor");
            const first = await db.supporterRecord.findUniqueOrThrow({ where: { accountId: sponsor.id } });
            expect(first.githubLogin).toBeNull();
            expect(await claim(sponsor.headers)).toBe("sponsor");
            expect(await db.supporterRecord.findUniqueOrThrow({ where: { accountId: sponsor.id } })).toEqual(first);

            mockGitHub(() => ({ nodes: [
                { isActive: false, isOneTimePayment: false, sponsorable: { login: "happier-dev" } },
                { isActive: false, isOneTimePayment: true, sponsorable: { login: "other-maintainer" } },
            ] }));
            expect(await claim(other.headers)).toBe("none");
            mockGitHub(() => null);
            expect(await claim(other.headers)).toBe("error");
            expect(await db.supporterRecord.findUnique({ where: { accountId: other.id } })).toBeNull();
        }, realAuth);
    });

    it("uses the owning session for attached records and the body code for detached records", async () => {
        const owner = await createSupporterAccount();
        const other = await createSupporterAccount();
        const attachedCode = "a".repeat(32);
        const detachedCode = "b".repeat(32);
        await db.supporterRecord.createMany({ data: [
            { accountId: owner.id, code: attachedCode, number: 1, grantedAt: new Date(), kind: "supporter_once" },
            { code: detachedCode, number: 2, grantedAt: new Date(), kind: "supporter_once" },
        ] });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const edit = (payload: object, headers?: Record<string, string>) =>
                app.inject({ method: "PATCH", url: "/v1/supporter/profile", headers, payload });
            expect((await edit({ accountId: owner.id, publicName: "Other" }, other.headers)).statusCode).toBe(400);
            expect((await edit({ code: attachedCode, publicName: "Other" }, other.headers)).statusCode).toBe(404);
            expect((await edit({ publicName: "Other" }, other.headers)).statusCode).toBe(404);
            expect((await edit({ publicName: "Own account" }, owner.headers)).statusCode).toBe(200);
            expect((await edit({ code: detachedCode, publicName: "Own code" })).statusCode).toBe(200);
            const lookup = await app.inject({ method: "POST", url: "/v1/supporter/lookup", payload: { code: detachedCode } });
            expect(lookup.statusCode).toBe(200);
            expect(lookup.json()).toMatchObject({ number: 2, publicName: "Own code", publicLink: null, githubLogin: null });
            expect(lookup.json()).not.toHaveProperty("code");
            const attachedLookup = await app.inject({
                method: "POST", url: "/v1/supporter/lookup", payload: { code: attachedCode },
            });
            expect(attachedLookup.statusCode).toBe(404);
            const own = await app.inject({ url: "/v1/account/supporter", headers: owner.headers });
            expect(own.statusCode).toBe(200);
            expect(own.json().record).toMatchObject({ number: 1, publicName: "Own account" });
        }, realAuth);
    });

    it("withdraws the wall profile on Account erasure and retains the issued number", async () => {
        const { deleteAccountForErasure } = await import("@/app/plugins/data/accountDataErase");
        const supporter = await createSupporterAccount();
        const { id } = await db.supporterRecord.create({ data: {
            accountId: supporter.id, code: "c".repeat(32), number: 7, grantedAt: new Date(),
            kind: "supporter_once", publicName: "Supporter Seven", publicLink: "https://example.test", githubLogin: "supporter-seven",
        } });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            expect((await app.inject({ url: "/v1/supporters/public" })).json()).toMatchObject({
                total: 1, entries: [{ number: 7, name: "Supporter Seven" }], githubLabels: ["supporter-seven"],
            });
            await expect(deleteAccountForErasure({ accountId: supporter.id })).resolves.toEqual({ status: "deleted" });
            expect(await db.supporterRecord.findUniqueOrThrow({ where: { id } })).toMatchObject({
                accountId: null, number: 7, publicName: null, publicLink: null, githubLogin: null,
            });
            expect((await app.inject({ url: "/v1/supporters/public" })).json()).toEqual({
                total: 1, entries: [], githubLabels: [],
            });
        }, realAuth);
    });

    it("keeps perk routes absent on a self-hosted server using GitHub sign-in", async () => {
        harness.resetEnv({ ...cloudEnv, POLAR_ACCESS_TOKEN: undefined });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            expect((await app.inject({ url: "/v1/supporters/public" })).statusCode).toBe(404);
            expect((await app.inject({ method: "PATCH", url: "/v1/supporter/profile", payload: {} })).statusCode).toBe(404);
            expect((await app.inject({ method: "POST", url: "/v1/supporter/github/start", payload: {} })).statusCode).toBe(404);
        }, realAuth);
    });
});

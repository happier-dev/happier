import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerOAuthCallbackRoute } from "@/app/api/routes/connect/oauthExternal/registerOAuthCallbackRoute";
import { auth } from "@/app/auth/auth";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { transferSupporterRecordInTx } from "@/app/billing/supporterRecords";
import { pkceChallengeS256 } from "@/app/oauth/pkce";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { http } = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:dns/promises")>();
    return { ...actual, lookup: (host: string, options: never) =>
        host === "discord.com" || host === "api.github.com"
            ? Promise.resolve([{ address: "140.82.112.4", family: 4 }])
            : actual.lookup(host, options) };
});
vi.mock("undici/index.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("undici/index.js")>(), fetch: http,
}));

const startPath = "/v1/supporter/discord/start";
const callbackPath = "/v1/supporter/discord/callback";
const discordUserId = "123456789012345678";
const cloudEnv = {
    POLAR_ACCESS_TOKEN: "polar-test",
    DISCORD_CLIENT_ID: "234567890123456789",
    DISCORD_CLIENT_SECRET: "discord-test-secret",
    DISCORD_REDIRECT_URL: `https://api.example.test${callbackPath}`,
};
const realAuth = { authentication: "real" } as const;

function registerCloudRoutes(app: Parameters<typeof billingRoutes>[0]) {
    billingRoutes(app, { env: cloudEnv });
    registerOAuthCallbackRoute(app);
}

function callbackUrl(authorizeUrl: URL) {
    return `${callbackPath}?${new URLSearchParams({ code: "discord-code", state: authorizeUrl.searchParams.get("state") ?? "" })}`;
}

// Only provider HTTP and DNS are replaced. The callback still exercises OAuth state, PKCE and SQLite.
function mockProviders(authorizeUrl: URL, options: Readonly<{ verified?: boolean; githubStatus?: number; discordWriteStatus?: number }> = {}) {
    const roleWrites: unknown[] = [];
    http.mockImplementation(async (url: URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (url.origin === "https://api.github.com") {
            expect(url.pathname).toBe("/search/issues");
            expect(url.searchParams.get("q")).toBe("repo:happier-dev/happier is:pr is:merged author:contributor");
            expect(headers.has("authorization")).toBe(false);
            return Response.json({ total_count: 1, incomplete_results: false, items: [{}] }, { status: options.githubStatus ?? 200 });
        }
        expect(url.origin).toBe("https://discord.com");
        if (url.pathname === "/api/v10/oauth2/token") {
            expect(init?.method).toBe("POST");
            expect(headers.get("content-type")).toContain("application/x-www-form-urlencoded");
            const form = new URLSearchParams(String(init?.body));
            expect(form.get("redirect_uri")).toBe(cloudEnv.DISCORD_REDIRECT_URL);
            if (pkceChallengeS256(form.get("code_verifier") ?? "") !== authorizeUrl.searchParams.get("code_challenge")) {
                return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            return Response.json({ access_token: "discord-user-token", token_type: "Bearer", expires_in: 604800, scope: "identify connections role_connections.write" });
        }
        expect(headers.get("authorization")).toBe("Bearer discord-user-token");
        if (url.pathname === "/api/v10/users/@me") return Response.json({ id: discordUserId, username: "DiscordName" });
        if (url.pathname === "/api/v10/users/@me/connections") {
            return Response.json([{ id: "41", type: "github", name: "contributor", verified: options.verified ?? true, visibility: 0 }]);
        }
        expect(init?.method).toBe("PUT");
        expect(url.pathname).toBe(`/api/v10/users/@me/applications/${cloudEnv.DISCORD_CLIENT_ID}/role-connection`);
        roleWrites.push(JSON.parse(String(init?.body)));
        return Response.json(roleWrites.at(-1), { status: options.discordWriteStatus ?? 200 });
    });
    return roleWrites;
}

describe("Discord Linked Roles on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-discord-", initAuth: true });
    }, 120_000);
    beforeEach(async () => {
        http.mockReset();
        await db.supporterRecord.deleteMany();
    });
    afterAll(async () => { await harness?.close(); });

    it("keeps all routes absent without the Discord secret", async () => {
        await withAuthenticatedTestApp((app) => billingRoutes(app, { env: { ...cloudEnv, DISCORD_CLIENT_SECRET: undefined } }), async (app) => {
            expect((await app.inject({ method: "POST", url: startPath, payload: {} })).statusCode).toBe(404);
            expect((await app.inject(startPath)).statusCode).toBe(404);
            expect((await app.inject(callbackPath)).statusCode).toBe(404);
        }, realAuth);
    });

    it("links only the proven record and re-verifies its current status from Discord", async () => {
        const { id: accountId } = await db.account.create({ data: { encryptionMode: "plain" } });
        const code = "b".repeat(32);
        const record = await db.supporterRecord.create({ data: { accountId, code, number: 12, kind: "supporter_once", grantedAt: new Date() } });
        const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            expect((await app.inject({ method: "POST", url: startPath, payload: { code } })).statusCode).toBe(404);
            const start = await app.inject({ method: "POST", url: startPath, headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(start.statusCode).toBe(200);
            const authorizeUrl = new URL(start.json().url);
            expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toEqual(["identify", "connections", "role_connections.write"]);
            expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
            expect(authorizeUrl.href).not.toContain(code);
            const roleWrites = mockProviders(authorizeUrl);
            const callback = await app.inject(callbackUrl(authorizeUrl));
            expect(callback.headers.location).toBe("https://happier.dev/supporters?linked=supporter");
            expect(roleWrites).toEqual([{ platform_name: "Happier", platform_username: "Supporter No. 12", metadata: { supporter: "1", contributor: "1" } }]);
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: record.id } })).discordUserId).toBe(discordUserId);

            const menuUrl = new URL((await app.inject(startPath)).headers.location!);
            const menuWrites = mockProviders(menuUrl, { verified: false });
            expect((await app.inject(callbackUrl(menuUrl))).headers.location).toBe("https://happier.dev/supporters?linked=supporter");
            expect(menuWrites).toEqual([{ platform_name: "Happier", platform_username: "Supporter No. 12", metadata: { supporter: "1", contributor: "0" } }]);

            await db.supporterRecord.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
            const reverifyUrl = new URL((await app.inject(startPath)).headers.location!);
            const reverifyWrites = mockProviders(reverifyUrl);
            expect((await app.inject(callbackUrl(reverifyUrl))).headers.location).toBe("https://happier.dev/supporters?linked=contributor");
            expect(reverifyWrites).toEqual([{ platform_name: "Happier", platform_username: "contributor", metadata: { supporter: "0", contributor: "1" } }]);
        }, realAuth);
    });

    it("refuses tampered, unrelated and replayed state and cannot redeem a foreign PKCE code", async () => {
        await withAuthenticatedTestApp((app) => {
            billingRoutes(app, { env: { ...cloudEnv, POLAR_ACCESS_TOKEN: undefined } });
            registerOAuthCallbackRoute(app);
        }, async (app) => {
            expect((await app.inject(`${callbackPath}?code=discord-code&state=tampered`)).json()).toEqual({ error: "invalid_state" });
            const unrelated = await auth.createOauthStateToken({ flow: "connect", provider: "github", purpose: "supporter_github", sid: "test" });
            expect((await app.inject(`${callbackPath}?code=discord-code&state=${encodeURIComponent(unrelated)}`)).statusCode).toBe(400);
            expect(http).not.toHaveBeenCalled();

            const first = new URL((await app.inject(startPath)).headers.location!);
            const second = new URL((await app.inject(startPath)).headers.location!);
            const roleWrites = mockProviders(first);
            const foreignCallback = await app.inject(callbackUrl(first).replace(callbackPath, "/v1/oauth/discord/callback"));
            expect(foreignCallback.headers.location).toContain("error=invalid_state");
            expect(http).not.toHaveBeenCalled();
            expect((await app.inject(callbackUrl(second))).headers.location).toBe("https://happier.dev/supporters?linked=none");
            expect(roleWrites).toEqual([]);
            expect((await app.inject(callbackUrl(first))).headers.location).toBe("https://happier.dev/supporters?linked=contributor");
            expect((await app.inject(callbackUrl(first))).statusCode).toBe(400);
            expect(roleWrites).toHaveLength(1);
        }, realAuth);
    });

    it("retains the proven detached link for menu verification if Discord refuses the role update", async () => {
        const code = "d".repeat(32);
        const { id } = await db.supporterRecord.create({ data: { code, number: 13, kind: "supporter_once", grantedAt: new Date() } });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const start = await app.inject({ method: "POST", url: startPath, payload: { code } });
            expect(start.statusCode).toBe(200);
            const authorizeUrl = new URL(start.json().url);
            const roleWrites = mockProviders(authorizeUrl, { githubStatus: 403, discordWriteStatus: 503 });
            expect((await app.inject(callbackUrl(authorizeUrl))).headers.location).toBe("https://happier.dev/supporters?linked=none");
            expect(roleWrites).toEqual([{ platform_name: "Happier", platform_username: "Supporter No. 13", metadata: { supporter: "1", contributor: "0" } }]);
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id } })).discordUserId).toBe(discordUserId);
            const menu = new URL((await app.inject(startPath)).headers.location!);
            const retryWrites = mockProviders(menu, { verified: false });
            expect((await app.inject(callbackUrl(menu))).headers.location).toBe("https://happier.dev/supporters?linked=supporter");
            expect(retryWrites).toEqual([{ platform_name: "Happier", platform_username: "Supporter No. 13", metadata: { supporter: "1", contributor: "0" } }]);
        }, realAuth);
    });

    it("refuses to publish roles for a Discord ID already linked to another record", async () => {
        const code = "a".repeat(32);
        const { id: linkedId } = await db.supporterRecord.create({ data: {
            code: "c".repeat(32), number: 15, kind: "supporter_once", grantedAt: new Date(), discordUserId,
        } });
        const { id } = await db.supporterRecord.create({ data: { code, number: 16, kind: "supporter_once", grantedAt: new Date() } });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const start = await app.inject({ method: "POST", url: startPath, payload: { code } });
            expect(start.statusCode).toBe(200);
            const authorizeUrl = new URL(start.json().url);
            const roleWrites = mockProviders(authorizeUrl, { verified: false });
            expect((await app.inject(callbackUrl(authorizeUrl))).headers.location).toBe("https://happier.dev/supporters?linked=none");
            expect(roleWrites).toEqual([]);
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id } })).discordUserId).toBeNull();
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: linkedId } })).discordUserId).toBe(discordUserId);
        }, realAuth);
    });

    it.each(["Account", "another detached code"])("does not overwrite another record's role after its proof was transferred to %s", async (destination) => {
        const code = "e".repeat(32);
        const { id } = await db.supporterRecord.create({ data: { code, number: 14, kind: "supporter_once", grantedAt: new Date() } });
        const { id: linkedId } = await db.supporterRecord.create({ data: {
            code: "c".repeat(32), number: 15, kind: "supporter_once", grantedAt: new Date(), discordUserId,
        } });
        const { id: accountId } = await db.account.create({ data: { encryptionMode: "plain" } });
        await withAuthenticatedTestApp(registerCloudRoutes, async (app) => {
            const start = await app.inject({ method: "POST", url: startPath, payload: { code } });
            expect(start.statusCode).toBe(200);
            const authorizeUrl = new URL(start.json().url);
            const roleWrites = mockProviders(authorizeUrl, { verified: false });
            const transferTarget = destination === "Account" ? accountId : "f".repeat(32);
            expect(await inTx((tx) => transferSupporterRecordInTx(tx, code, transferTarget))).toBe(true);
            expect((await app.inject(callbackUrl(authorizeUrl))).headers.location).toBe("https://happier.dev/supporters?linked=none");
            expect(roleWrites).toEqual([]);
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id } })).discordUserId).toBeNull();
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: linkedId } })).discordUserId).toBe(discordUserId);
        }, realAuth);
    });
});

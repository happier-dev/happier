import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { auth } from "@/app/auth/auth";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { transferSupporterRecordInTx } from "@/app/billing/supporterRecords";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const START = "/v1/supporter/discord/start";
const CALLBACK = "/v1/supporter/discord/callback";
const RESULT = "https://happier.dev/supporters?linked=";
const env = {
    POLAR_ACCESS_TOKEN: "test-polar-token",
    DISCORD_CLIENT_ID: "123456",
    DISCORD_CLIENT_SECRET: "test-secret",
    DISCORD_REDIRECT_URL: `https://api.happier.dev${CALLBACK}`,
};
const discordUserId = "987654";

describe("Supporter Discord Linked Roles on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-discord-", initAuth: true });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    it.each(["DISCORD_CLIENT_SECRET", "POLAR_ACCESS_TOKEN"] as const)("keeps all Discord routes closed without %s", async (variable) => {
        const app = createAuthenticatedTestApp();
        billingRoutes(app, { env: { ...env, [variable]: undefined } });
        try {
            for (const [method, url] of [["POST", START], ["GET", START], ["GET", CALLBACK]] as const) {
                expect((await app.inject({ method, url })).statusCode).toBe(404);
            }
        } finally {
            await app.close();
        }
    });

    it("links an earned supporter and re-verifies the Discord identity without a Happier account", async () => {
        const record = await db.supporterRecord.create({
            data: { code: randomBytes(16).toString("hex"), number: 42, kind: "supporter_once", grantedAt: new Date() },
        });
        let verified = true;
        let linkedDiscordUserId = discordUserId;
        let githubStatus = 200;
        let exchanges = 0;
        const metadata: unknown[] = [];
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === "api.github.com" && url.pathname === "/search/issues") {
                expect(url.searchParams.get("q")).toBe("repo:happier-dev/happier is:pr is:merged author:octocat");
                return Response.json({ total_count: 1 }, { status: githubStatus });
            }
            expect(url.hostname).toBe("discord.com");
            switch (url.pathname) {
                case "/api/v10/oauth2/token":
                    exchanges++;
                    expect(init?.method).toBe("POST");
                    expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toBeTruthy();
                    return Response.json({ access_token: "test-access-token" });
                case "/api/v10/users/@me":
                    return Response.json({ id: linkedDiscordUserId });
                case "/api/v10/users/@me/connections":
                    return Response.json([{ type: "github", name: "octocat", verified }]);
                case "/api/v10/users/@me/applications/123456/role-connection":
                    expect(init?.method).toBe("PUT");
                    metadata.push(JSON.parse(String(init?.body)));
                    return Response.json({});
                default:
                    throw new Error(`Unexpected request to ${url.pathname}`);
            }
        };
        const app = createAuthenticatedTestApp();
        billingRoutes(app, { env, fetchImpl });
        const finish = async (state: string) => await app.inject({ url: `${CALLBACK}?code=consent&state=${encodeURIComponent(state)}` });
        const startFromDiscord = async () => {
            const response = await app.inject({ url: START });
            expect(response.statusCode).toBe(302);
            return new URL(response.headers.location as string).searchParams.get("state")!;
        };

        try {
            expect((await app.inject({ method: "POST", url: START })).statusCode).toBe(401);
            const start = await app.inject({ method: "POST", url: START, payload: { code: record.code } });
            expect(start.statusCode).toBe(200);
            const authorize = new URL(start.json().url);
            expect(authorize.origin).toBe("https://discord.com");
            expect(authorize.searchParams.get("scope")).toBe("identify connections role_connections.write");
            expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
            expect(authorize.href).not.toContain(record.code);
            const state = authorize.searchParams.get("state")!;
            const token = (await auth.verifyOauthStateToken(state))!;
            const foreignState = await auth.createOauthStateToken({ flow: "supporter", provider: "github", sid: token.sid });
            expect((await finish(foreignState)).headers.location).toBe(RESULT + "error&via=discord");
            expect((await finish(state + "tampered")).headers.location).toBe(RESULT + "error&via=discord");
            expect(exchanges).toBe(0);

            expect((await finish(state)).headers.location).toBe(RESULT + "supporter&via=discord");
            expect(metadata.at(-1)).toEqual({
                platform_name: "Happier", platform_username: "Supporter No. 42", metadata: { supporter: "1", contributor: "1" },
            });
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: record.id } }))).toMatchObject({ discordUserId });
            expect((await finish(state)).headers.location).toBe(RESULT + "error&via=discord");
            expect(exchanges).toBe(1);

            // A detached restore preserves the record id but replaces the proof.
            const staleStart = await app.inject({ method: "POST", url: START, payload: { code: record.code } });
            const staleState = new URL(staleStart.json().url).searchParams.get("state")!;
            expect(await inTx((tx) => transferSupporterRecordInTx(tx, record.code, randomBytes(16).toString("hex")))).toBe(true);
            expect((await finish(staleState)).headers.location).toBe(RESULT + "error&via=discord");
            expect(metadata).toHaveLength(1);

            const other = await db.supporterRecord.create({
                data: { code: randomBytes(16).toString("hex"), number: 43, kind: "supporter_once", grantedAt: new Date() },
            });
            const otherStart = await app.inject({ method: "POST", url: START, payload: { code: other.code } });
            const otherState = new URL(otherStart.json().url).searchParams.get("state")!;
            expect((await finish(otherState)).headers.location).toBe(RESULT + "error&via=discord");
            expect(metadata).toHaveLength(1);
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: other.id } })).discordUserId).toBeNull();

            verified = false;
            expect((await finish(await startFromDiscord())).headers.location).toBe(RESULT + "supporter&via=discord");
            expect(metadata.at(-1)).toMatchObject({ metadata: { supporter: "1", contributor: "0" } });

            await db.supporterRecord.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
            expect((await finish(await startFromDiscord())).headers.location).toBe(RESULT + "none&via=discord");
            expect(metadata.at(-1)).toMatchObject({ metadata: { supporter: "0", contributor: "0" } });

            verified = true;
            githubStatus = 429;
            expect((await finish(await startFromDiscord())).headers.location).toBe(RESULT + "none&via=discord&retry=1");
            expect(metadata.at(-1)).toMatchObject({ metadata: { supporter: "0", contributor: "0" } });

            const account = await db.account.create({ data: { publicKey: randomBytes(32).toString("hex") } });
            const attached = await db.supporterRecord.create({ data: {
                accountId: account.id, code: randomBytes(16).toString("hex"), number: 44,
                kind: "supporter_once", grantedAt: new Date(),
            } });
            expect((await app.inject({ method: "POST", url: START, payload: { code: attached.code } })).statusCode).toBe(404);
            const attachedStart = await app.inject({ method: "POST", url: START, headers: { "x-test-user-id": account.id } });
            expect(attachedStart.statusCode).toBe(200);
            const attachedState = new URL(attachedStart.json().url).searchParams.get("state")!;
            linkedDiscordUserId = "456789";
            verified = false;
            expect((await finish(attachedState)).headers.location).toBe(RESULT + "supporter&via=discord");
            expect(metadata.at(-1)).toMatchObject({ platform_username: "Supporter No. 44", metadata: { supporter: "1", contributor: "0" } });
            expect((await db.supporterRecord.findUniqueOrThrow({ where: { id: attached.id } })).discordUserId).toBe(linkedDiscordUserId);
        } finally {
            await app.close();
        }
    });
});

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return trackApp(typed);
}

const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9e8AAAAASUVORK5CYII=",
    "base64",
);

describe("connectRoutes (GitHub) username flow (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connect-gh-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.restoreEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.userRelationship.deleteMany(),
            () => db.uploadedFile.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("redirects to github=username_required and does not connect when the GitHub login is already taken and the user has no username", async () => {
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

        const taken = await db.account.create({
            data: { publicKey: "pk-taken", username: "octocat" },
            select: { id: true },
        });
        const u1 = await db.account.create({
            data: { publicKey: "pk-u1", username: null },
            select: { id: true },
        });

        const avatarUrl = "https://avatars.example.test/octo.png";
        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: avatarUrl,
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any, init?: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            if (url === avatarUrl) {
                return {
                    ok: true,
                    arrayBuffer: async () => ONE_BY_ONE_PNG.buffer.slice(ONE_BY_ONE_PNG.byteOffset, ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)} ${JSON.stringify(init ?? {})}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const location = res.headers.location;
        expect(typeof location).toBe("string");

        const redirect = new URL(location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("connect");
        expect(redirect.searchParams.get("status")).toBe("username_required");
        expect(redirect.searchParams.get("login")).toBe("octocat");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const updated = await db.account.findUnique({
            where: { id: u1.id },
            select: { username: true },
        });
        expect(updated?.username).toBeNull();
        const identity = await db.accountIdentity.findFirst({
            where: { accountId: u1.id, provider: "github" },
            select: { id: true },
        });
        expect(identity).toBeNull();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();

        await app.close();
        expect(taken).toBeTruthy();
    });

    it("finalizes GitHub connect after username selection, connecting GitHub and setting the chosen username", async () => {
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

        await db.account.create({
            data: { publicKey: "pk-taken", username: "octocat" },
            select: { id: true },
        });
        const u1 = await db.account.create({
            data: { publicKey: "pk-u1", username: null },
            select: { id: true },
        });

        const avatarUrl = "https://avatars.example.test/octo.png";
        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: avatarUrl,
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            if (url === avatarUrl) {
                return {
                    ok: true,
                    arrayBuffer: async () => ONE_BY_ONE_PNG.buffer.slice(ONE_BY_ONE_PNG.byteOffset, ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });
        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.searchParams.get("flow")).toBe("connect");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const finalize = await app.inject({
            method: "POST",
            url: "/v1/connect/external/github/finalize",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { pending, username: "octocat_2" },
        });
        expect(finalize.statusCode).toBe(200);
        expect(finalize.json()).toEqual({ success: true });

        const updated = await db.account.findUnique({
            where: { id: u1.id },
            select: { username: true },
        });
        expect(updated?.username).toBe("octocat_2");
        const identity = await db.accountIdentity.findFirst({
            where: { accountId: u1.id, provider: "github" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe(String(ghProfile.id));
        expect(identity?.providerLogin).toBe("octocat");

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeNull();

        await app.close();
    });
});

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { decryptString, initEncrypt } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { startOidcStubServer, type OidcStubServer } from "../../testkit/oidcStub";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function runServerPrismaMigrateDeploySqlite(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}). ${out}`);
    }
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return trackApp(typed);
}

describe("connectRoutes (OIDC userinfo) external auth flow (integration)", () => {
    const envBackup = { ...process.env };
    const originalFetch = globalThis.fetch;
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    let oidcStub: OidcStubServer;
    let oidcIssuer: string;

    beforeAll(async () => {
        oidcStub = await startOidcStubServer({
            includeUserInfoEndpoint: true,
            userInfoClaims: {
                sub: "user_1",
                groups: ["eng", "sre"],
            },
        });
        oidcIssuer = oidcStub.issuer;

        baseDir = await mkdtemp(join(tmpdir(), "happier-oidc-userinfo-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
        await initEncrypt();
    }, 120_000);

    const restoreEnv = (base: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) {
            if (!(key in base)) delete (process.env as any)[key];
        }
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string") process.env[key] = value;
        }
    };

    afterEach(async () => {
        await closeTrackedApps();
        restoreEnv(testEnvBase);
        globalThis.fetch = originalFetch;
        oidcStub.reset();
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        globalThis.fetch = originalFetch;
        await oidcStub.close();
        await rm(baseDir, { recursive: true, force: true });
    });

    it("merges /userinfo claims into the stored pending profile when fetchUserInfo=true", async () => {
        process.env.AUTH_SIGNUP_PROVIDERS = "okta";
        process.env.AUTH_PROVIDERS_CONFIG_JSON = JSON.stringify([
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                fetchUserInfo: true,
            },
        ]);
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

        const seed = new Uint8Array(32).fill(1);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const res = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.searchParams.get("error")).toBeNull();
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        const value = JSON.parse(pendingRow!.value) as any;
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(kp.publicKey));
        const profileBytes = privacyKit.decodeBase64(value.profileEnc);
        const profileJson = decryptString(
            ["auth", "external", "okta", "pending", pending as string, publicKeyHex, "profile"],
            profileBytes,
        );
        const profile = JSON.parse(profileJson) as any;
        expect(profile?.groups).toEqual(["eng", "sre"]);

        await app.close();
    });
});

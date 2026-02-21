import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

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

describe("authRoutes (mTLS) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-mtls-"));
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
    }, 120_000);

    const restoreEnv = (base: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) {
            if (!(key in base)) {
                delete (process.env as any)[key];
            }
        }
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string") {
                process.env[key] = value;
            }
        }
    };

    afterEach(async () => {
        await closeTrackedApps();
        restoreEnv(testEnvBase);
        vi.unstubAllGlobals();
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("auto-provisions a keyless account and returns a bearer token (forwarded mode)", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });
        expect(readAuthMtlsFeatureEnv(process.env).allowedIssuers).toEqual(["cn=example root ca"]);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "  CN=Example Root CA  ",
            },
        });

        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as any;
        expect(body.success).toBe(true);
        expect(typeof body.token).toBe("string");
        expect(body.token.length).toBeGreaterThan(10);

        const accounts = await db.account.findMany({
            include: { AccountIdentity: { orderBy: { provider: "asc" } } },
            orderBy: { createdAt: "asc" },
        });
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.publicKey).toBeNull();
        expect(accounts[0]?.AccountIdentity?.[0]?.provider).toBe("mtls");
        expect(accounts[0]?.AccountIdentity?.[0]?.providerUserId).toBe("alice@example.com");

        await app.close();
    });

    it("rejects a forwarded identity when an issuer allowlist is configured and the issuer does not match", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=trusted ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Untrusted CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("accepts an issuer allowlist match when the forwarded issuer is a full DN (CN extracted)", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "Example Root CA",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "C=US, O=Example Corp, CN=Example Root CA",
            },
        });

        expect(res.statusCode, res.body).toBe(200);

        await app.close();
    });

    it("rejects issuer allowlist entries that are full DNs when the forwarded issuer has the same CN but a different DN", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            // Full DN allowlist entry (intended to be exact-match, not just CN-match).
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "C=US, O=Example Corp, CN=Example Root CA",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                // Same CN but different organization.
                "x-happier-client-cert-issuer": "C=US, O=Other Corp, CN=Example Root CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("enforces allowed email domains when identitySource=san_upn", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_upn",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_UPN_HEADER: "x-happier-client-cert-upn",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-upn": "alice@evil.example",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("supports browser handoff via /start -> /complete -> /claim (forwarded mode)", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const startRes = await app.inject({
            method: "GET",
            url: "/v1/auth/mtls/start?returnTo=" + encodeURIComponent("happier://auth/return"),
        });
        expect(startRes.statusCode).toBe(302);
        const completeUrl = String(startRes.headers.location ?? "");
        expect(completeUrl).toContain("/v1/auth/mtls/complete");

        const completeRes = await app.inject({
            method: "GET",
            url: completeUrl,
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(completeRes.statusCode, completeRes.body).toBe(302);
        const returnUrl = String(completeRes.headers.location ?? "");
        const parsed = new URL(returnUrl);
        expect(parsed.protocol).toBe("happier:");
        const code = parsed.searchParams.get("code");
        expect(typeof code).toBe("string");
        expect(code?.length ?? 0).toBeGreaterThan(10);

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code },
        });
        expect(claimRes.statusCode).toBe(200);
        const claimBody = claimRes.json() as any;
        expect(claimBody.success).toBe(true);
        expect(typeof claimBody.token).toBe("string");

        // Claim codes must be single-use to avoid replay within the TTL window.
        const claimRes2 = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code },
        });
        expect(claimRes2.statusCode).toBe(401);
        expect(claimRes2.json()).toEqual({ error: "invalid-code" });

        await app.close();
    });

    it("allows only one successful /claim even under concurrent attempts", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const startRes = await app.inject({
            method: "GET",
            url: "/v1/auth/mtls/start?returnTo=" + encodeURIComponent("happier://auth/return"),
        });
        expect(startRes.statusCode).toBe(302);

        const completeRes = await app.inject({
            method: "GET",
            url: String(startRes.headers.location ?? ""),
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(completeRes.statusCode).toBe(302);

        const returnUrl = new URL(String(completeRes.headers.location ?? ""));
        const code = returnUrl.searchParams.get("code");
        expect(code).toBeTruthy();

        const [c1, c2] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code } }),
            app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code } }),
        ]);

        const statuses = [c1.statusCode, c2.statusCode].sort();
        expect(statuses).toEqual([200, 401]);

        await app.close();
    });

    it("rejects returnTo values that only match by string prefix but do not match the allowed origin", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",

            // A common operator config: "only allow returnTo into the webapp origin".
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "https://app.happier.dev",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url:
                "/v1/auth/mtls/start?returnTo=" +
                encodeURIComponent("https://app.happier.dev.evil.com/oauth/mtls"),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-returnTo" });

        await app.close();
    });

    it("does not register mTLS routes when server storagePolicy=required_e2ee", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
            },
        });

        expect(res.statusCode).toBe(404);

        await app.close();
    });

    it("rejects identities that do not match allowed email domains", async () => {
        Object.assign(process.env, {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@evil.example",
                "x-happier-client-cert-sha256": "sha256:abc123",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });
});

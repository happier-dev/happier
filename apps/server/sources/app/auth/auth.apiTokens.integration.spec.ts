import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type ApiTokenAuth = typeof auth & {
    createApiToken(params: Readonly<{
        accountId: string;
        label: string;
        expiresAt?: Date | null;
    }>): Promise<Readonly<{
        tokenId: string;
        token: string;
        label: string;
        displayPrefix: string;
        createdAt: Date;
        expiresAt: Date | null;
    }>>;
    listApiTokens(accountId: string): Promise<ReadonlyArray<Readonly<{
        tokenId: string;
        label: string;
        displayPrefix: string;
        createdAt: Date;
        lastUsedAt: Date | null;
        expiresAt: Date | null;
    }>>>;
    revokeApiToken(params: Readonly<{ accountId: string; tokenId: string }>): Promise<boolean>;
    verifyPat(token: string, signal?: AbortSignal): Promise<
        | Readonly<{
            ok: true;
            accountId: string;
            principalId: string;
            credentialId: string;
            expiresAt: Date | null;
            authority: "account_automation";
        }>
        | Readonly<{ ok: false; reason: "invalid_token" }>
    >;
};

const apiTokenAuth = auth as ApiTokenAuth;

type ApiTokenStore = {
    findUnique(params: Readonly<{
        where: Readonly<{ id: string }>;
        select: Readonly<{ secretDigest: true; displayPrefix: true }>;
    }>): Promise<Readonly<{ secretDigest: string; displayPrefix: string }> | null>;
};

function getApiTokenStore(): ApiTokenStore {
    return (db as unknown as Readonly<{ accountApiToken: ApiTokenStore }>).accountApiToken;
}

const UNKNOWN_API_TOKEN = `hap_v1_550e8400-e29b-41d4-a716-446655440000_${"A".repeat(43)}`;

describe("auth (API tokens)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-tokens-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        harness.resetEnv();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function withAuthenticatedApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
        const app = Fastify({ logger: false });
        enableAuthentication(app as any);
        app.get("/private", {
            // This fixture represents an explicit PAT-capable boundary. The
            // decorator's ordinary default remains deny-by-default.
            config: { allowApiToken: true },
            preHandler: (app as any).authenticate,
        }, async (request: any) => ({
            authority: request.authAuthority,
            tokenKind: request.authTokenKind,
        }));
        await app.ready();
        try {
            await run(app);
        } finally {
            await app.close();
        }
    }

    it("collapses malformed and unknown bearer credentials into the same opaque invalid_token response", async () => {
        await withAuthenticatedApp(async (app) => {
            const responses = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: "Bearer hap_v1_malformed" },
                }),
                app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: `Bearer ${UNKNOWN_API_TOKEN}` },
                }),
            ]);

            for (const response of responses) {
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }
        });
    });

    it("mints a one-time plaintext token, verifies its account-automation provenance, lists summaries, and revokes by deletion", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-lifecycle" },
            select: { id: true },
        });

        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            label: "CI deploy",
        });
        const secret = minted.token.split("_")[3] ?? "";

        expect(minted.token).toMatch(/^hap_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
        await expect(auth.verifyToken(minted.token)).resolves.toEqual({
            userId: account.id,
            authority: "account_automation",
            authTokenKind: "api_token",
        });

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                authority: "account_automation",
                tokenKind: "api_token",
            });
        });

        const stored = await getApiTokenStore().findUnique({
            where: { id: minted.tokenId },
            select: { secretDigest: true, displayPrefix: true },
        });
        expect(stored).not.toBeNull();
        expect(stored?.secretDigest).not.toContain(secret);
        expect(stored?.secretDigest).not.toBe(secret);
        expect(stored?.displayPrefix).toBe(minted.displayPrefix);

        await expect(apiTokenAuth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({
                tokenId: minted.tokenId,
                label: "CI deploy",
                displayPrefix: minted.displayPrefix,
                lastUsedAt: expect.any(Date),
                expiresAt: null,
            }),
        ]);
        const listed = await apiTokenAuth.listApiTokens(account.id);
        expect(JSON.stringify(listed)).not.toContain(minted.token);
        expect(JSON.stringify(listed)).not.toContain(stored?.secretDigest ?? "");

        await expect(apiTokenAuth.revokeApiToken({
            accountId: account.id,
            tokenId: minted.tokenId,
        })).resolves.toBe(true);
        await expect(auth.verifyToken(minted.token)).resolves.toBeNull();

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        });
    });

    it("exposes a PAT-only verification seam with stable credential provenance", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-pat-only-seam" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            label: "Daemon cache",
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
        });
        const signedAccountToken = await auth.createToken(account.id);

        await expect(apiTokenAuth.verifyPat(minted.token)).resolves.toEqual({
            ok: true,
            accountId: account.id,
            principalId: account.id,
            credentialId: minted.tokenId,
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
            authority: "account_automation",
        });
        await expect(apiTokenAuth.verifyPat(signedAccountToken)).resolves.toEqual({
            ok: false,
            reason: "invalid_token",
        });
    });

    it("rejects expired and deleted-account tokens while retaining opaque external failure", async () => {
        const expiringAccount = await db.account.create({
            data: { publicKey: "api-token-expiry" },
            select: { id: true },
        });
        const expiringToken = await apiTokenAuth.createApiToken({
            accountId: expiringAccount.id,
            label: "Short-lived tool",
            expiresAt: new Date("2026-08-22T12:01:00.000Z"),
        });
        vi.setSystemTime(new Date("2026-08-22T12:01:00.001Z"));
        await expect(auth.verifyToken(expiringToken.token)).resolves.toBeNull();

        const deletedAccount = await db.account.create({
            data: { publicKey: "api-token-deleted-account" },
            select: { id: true },
        });
        const deletedAccountToken = await apiTokenAuth.createApiToken({
            accountId: deletedAccount.id,
            label: "Deleted account tool",
        });
        await db.account.delete({ where: { id: deletedAccount.id } });
        await expect(auth.verifyToken(deletedAccountToken.token)).resolves.toBeNull();

        await withAuthenticatedApp(async (app) => {
            for (const token of [expiringToken.token, deletedAccountToken.token]) {
                const response = await app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: `Bearer ${token}` },
                });
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }
        });
    });

    it("does not advance lastUsedAt again before the owner-local five-minute write throttle elapses", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-last-used" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            label: "Build agent",
        });

        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        const first = (await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt;
        expect(first).toEqual(new Date("2026-08-22T12:00:00.000Z"));

        vi.setSystemTime(new Date("2026-08-22T12:04:59.999Z"));
        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt).toEqual(first);

        vi.setSystemTime(new Date("2026-08-22T12:05:00.000Z"));
        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt)
            .toEqual(new Date("2026-08-22T12:05:00.000Z"));
    });

    it("fails an API token at the existing account-eligibility gate", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
        });
        const account = await db.account.create({
            data: { publicKey: "api-token-ineligible" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            label: "Ineligible automation",
        });

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "provider-required", provider: "github" });
        });
    });
});

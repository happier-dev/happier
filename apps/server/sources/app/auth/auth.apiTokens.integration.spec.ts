import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    API_TOKEN_FULL_GRANT_V1,
    parseAccountApiTokenBearerV1,
} from "@happier-dev/protocol";

const apiTokenAuth = auth;
const fullGrantProjection = { grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, embedConfig: null };

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
            },
        });
    }, 120_000);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
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
            apiTokenPrincipal: request.apiTokenPrincipal,
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
            tokenId: crypto.randomUUID(),
            label: "CI deploy",
        });
        const parsed = parseAccountApiTokenBearerV1(minted.token);
        expect(parsed).not.toBeNull();
        const secret = parsed?.secret ?? "";

        expect(minted.token).toMatch(/^hap_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
        expect(minted.displayPrefix).toBe(`hap_v1_${minted.tokenId.slice(0, 8)}`);
        expect(minted.hasEncryptionAccess).toBe(false);
        await expect(auth.verifyToken(minted.token)).resolves.toEqual({
            userId: account.id,
            authority: "account_automation",
            authTokenKind: "api_token",
            legacy: false,
            apiTokenPrincipal: {
                accountId: account.id,
                principalId: account.id,
                credentialId: minted.tokenId,
                authority: "account_automation",
                expiresAt: null,
                ...fullGrantProjection,
            },
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
                apiTokenPrincipal: {
                    accountId: account.id,
                    principalId: account.id,
                    credentialId: minted.tokenId,
                    authority: "account_automation",
                    expiresAt: null,
                    ...fullGrantProjection,
                },
            });
        });

        const stored = await db.accountApiToken.findUnique({
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
                hasEncryptionAccess: false,
            }),
        ]);
        const listed = await apiTokenAuth.listApiTokens(account.id);
        expect(JSON.stringify(listed)).not.toContain(minted.token);
        expect(JSON.stringify(listed)).not.toContain(stored?.secretDigest ?? "");

        await expect(apiTokenAuth.revokeApiToken({
            accountId: account.id,
            tokenId: minted.tokenId,
        })).resolves.toEqual({ revoked: true, revokedTokenIds: [minted.tokenId] });
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

    it("uses one captured creation time when validating and persisting a near-boundary expiry", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-single-expiry-clock" },
            select: { id: true },
        });
        const creationTime = new Date("2026-08-22T12:00:00.000Z");
        const expiresAt = new Date("2026-08-22T12:00:00.001Z");
        vi.setSystemTime(new Date("2026-08-22T12:00:05.000Z"));

        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Boundary expiry",
            expiresAt,
        }, creationTime);

        expect(minted.createdAt).toEqual(creationTime);
        expect(minted.expiresAt).toEqual(expiresAt);
    });

    it("exposes a PAT-only verification seam with stable credential provenance", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-pat-only-seam" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Daemon cache",
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
        });
        const signedAccountToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

        await expect(apiTokenAuth.verifyPat(minted.token)).resolves.toEqual({
            ok: true,
            accountId: account.id,
            principalId: account.id,
            credentialId: minted.tokenId,
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
            authority: "account_automation",
            ...fullGrantProjection,
        });
        await expect(apiTokenAuth.verifyPat(signedAccountToken)).resolves.toEqual({
            ok: false,
            reason: "invalid_token",
        });
    });

    it("writes canonical full grants and refuses missing or malformed stored grants", async () => {
        const account = await db.account.create({ data: { publicKey: 'canonical-grant-reader' } });
        const token = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: 'Canonical' });
        expect(await db.accountApiToken.findUniqueOrThrow({ where: { id: token.tokenId }, select: { accessGrant: true } }))
            .toEqual({ accessGrant: API_TOKEN_FULL_GRANT_V1 });
        expect(await auth.verifyPat(token.token)).toMatchObject({ ok: true, ...fullGrantProjection });
        await db.accountApiToken.update({ where: { id: token.tokenId }, data: { accessGrant: getActivePrismaRuntime().DbNull } });
        expect(await auth.verifyPat(token.token)).toEqual({ ok: false, reason: 'invalid_token' });
        await expect(auth.listApiTokens(account.id)).rejects.toMatchObject({ code: 'invalid_token' });
        await db.accountApiToken.update({ where: { id: token.tokenId }, data: { accessGrant: { v: 99 } } });
        expect(await auth.verifyPat(token.token)).toEqual({ ok: false, reason: 'invalid_token' });
        await expect(auth.listApiTokens(account.id)).rejects.toMatchObject({ code: 'invalid_token' });
    });

    it("reads stored grants and embed configurations by known fields while writes remain strict", async () => {
        const account = await db.account.create({ data: { publicKey: 'stored-grant-projection' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['s1'], machines: [] } };
        const embedConfig = {
            v: 1 as const,
            ui: { attachments: true },
            newChat: { enabled: false },
            organization: { folderId: null, tagIds: [] },
            style: { v: 1 as const, typography: { fontFamily: 'Inter' }, parts: { composer: { radius: 'md' as const } } },
        };
        const minted = await auth.createApiToken({
            accountId: account.id, tokenId: crypto.randomUUID(), label: 'Stored projection', grant, embedConfig,
        });
        const storedGrant = { ...grant, ignored: true, targets: { ...grant.targets, ignored: true } };
        const storedConfig = {
            ...embedConfig, ignored: true,
            ui: { ...embedConfig.ui, ignored: true },
            newChat: { ...embedConfig.newChat, ignored: true },
            organization: { ...embedConfig.organization, ignored: true },
            style: {
                ...embedConfig.style, ignored: true,
                typography: { ...embedConfig.style.typography, ignored: true },
                parts: { composer: { ...embedConfig.style.parts.composer, ignored: true }, ignored: true },
            },
        };
        await db.accountApiToken.update({
            where: { id: minted.tokenId }, data: { accessGrant: storedGrant, embedConfig: storedConfig },
        });
        expect(await auth.verifyPat(minted.token)).toMatchObject({ ok: true, grant, embedConfig });
        expect(await auth.listApiTokens(account.id)).toEqual([expect.objectContaining({ grant, embedConfig })]);
        await expect(auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, grant: storedGrant })).rejects.toThrow();
        await expect(auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, embedConfig: storedConfig })).rejects.toThrow();
        await auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, grant, embedConfig });
        expect(await db.accountApiToken.findUnique({
            where: { id: minted.tokenId }, select: { accessGrant: true, embedConfig: true },
        })).toEqual({ accessGrant: grant, embedConfig });
        await db.accountApiToken.update({ where: { id: minted.tokenId }, data: { accessGrant: { ...storedGrant, approve: 'true' } } });
        expect(await auth.verifyPat(minted.token)).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it("copies only explicit server-verified evidence into the PAT row and fails malformed snapshots closed", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-evidence" },
            select: { id: true },
        });
        const evidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];
        const minted = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Qualified automation",
            authenticationEvidence: evidence,
        });

        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
            authenticationEvidence: evidence,
        });
        await expect(auth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ hasUnattendedTeamAccess: true }),
        ]);

        await db.accountApiToken.update({
            where: { id: minted.tokenId },
            data: { authenticationEvidence: { v: 1, ignored: true, evidence: [{ ...evidence[0], ignored: true }] } },
        });
        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({ authenticationEvidence: evidence });
        await expect(auth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ hasUnattendedTeamAccess: true }),
        ]);

        await db.accountApiToken.update({
            where: { id: minted.tokenId },
            data: { authenticationEvidence: { v: 99, evidence } },
        });
        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
        });
        expect((await auth.verifyToken(minted.token))?.authenticationEvidence).toBeUndefined();

        await expect(auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Over-bound automation",
            authenticationEvidence: Array.from({ length: 33 }, (_, index) => ({
                kind: "home_method" as const,
                methodId: `method-${index}`,
            })),
        })).rejects.toMatchObject({ code: "credential_authentication_evidence_limit" });
        expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("invalidates signed sessions at sign-out-everywhere while preserving PATs", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-sign-out-everywhere" },
            select: { id: true },
        });
        const preEpochToken = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Pre-epoch automation",
        });
        const preEpochSigned = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        await expect(auth.verifyToken(preEpochToken.token)).resolves.not.toBeNull();

        await apiTokenAuth.signOutEverywhere(account.id);

        await expect(auth.verifyToken(preEpochToken.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
        });
        await expect(apiTokenAuth.verifyPat(preEpochToken.token)).resolves.toMatchObject({
            ok: true,
            accountId: account.id,
            credentialId: preEpochToken.tokenId,
            authority: "account_automation",
        });
        await expect(apiTokenAuth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ tokenId: preEpochToken.tokenId, label: "Pre-epoch automation" }),
        ]);

        // Credentials minted after the epoch change remain valid.
        const postEpochToken = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Post-epoch automation",
        });
        await expect(auth.verifyToken(postEpochToken.token)).resolves.not.toBeNull();
        const postEpochSigned = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        await expect(auth.verifyToken(postEpochSigned)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account",
            legacy: false,
        });
        // The pre-epoch signed token was already invalidated by the epoch check.
        await expect(auth.verifyToken(preEpochSigned)).resolves.toBeNull();
    });

    it("rejects expired and deleted-account tokens while retaining opaque external failure", async () => {
        const expiringAccount = await db.account.create({
            data: { publicKey: "api-token-expiry" },
            select: { id: true },
        });
        const expiringToken = await apiTokenAuth.createApiToken({
            accountId: expiringAccount.id,
            tokenId: crypto.randomUUID(),
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
            tokenId: crypto.randomUUID(),
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
            tokenId: crypto.randomUUID(),
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
        });
        const account = await db.account.create({
            data: { publicKey: "api-token-ineligible" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
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

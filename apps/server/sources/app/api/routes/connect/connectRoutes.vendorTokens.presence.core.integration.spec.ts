import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    listQualifiedConnectedAccounts,
    mutateQualifiedConnectedServiceCredential,
} from "./qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "./qualifiedConnectedAccounts/identity";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify();
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

describe("connectRoutes (vendor tokens) presence-only reads (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-vendor-tokens-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("keeps core routes registered when the retired master env is off and still enforces auth", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0" });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/connect/tokens",
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Unauthorized" });
    });

    it("does not return decrypted tokens from GET endpoints", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u1" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v1/connect/openai/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "sk-test" },
        });
        if (register.statusCode !== 200) {
            throw new Error(`register failed: ${register.statusCode} ${register.body}`);
        }
        expect(register.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v1/connect/openai/token",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({ hasToken: true });

        const getAll = await app.inject({
            method: "GET",
            url: "/v1/connect/tokens",
            headers: { "x-test-user-id": user.id },
        });
        expect(getAll.statusCode).toBe(200);
        expect(getAll.json()).toEqual({
            tokens: [{ vendor: "openai", hasToken: true }],
        });
    });

    it("derives vendor-token presence from the canonical qualified identity", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-vendor-tokens-canonical-read" },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai",
                profileId: "default",
                ...resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: "anthropic",
                    profileId: "default",
                }),
                token: Buffer.from("legacy-anthropic", "utf8"),
                metadata: null,
            },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const legacyTuplePresence = await app.inject({
            method: "GET",
            url: "/v1/connect/openai/token",
            headers: { "x-test-user-id": user.id },
        });
        const qualifiedPresence = await app.inject({
            method: "GET",
            url: "/v1/connect/anthropic/token",
            headers: { "x-test-user-id": user.id },
        });
        const all = await app.inject({
            method: "GET",
            url: "/v1/connect/tokens",
            headers: { "x-test-user-id": user.id },
        });

        expect(legacyTuplePresence.json()).toEqual({ hasToken: false });
        expect(qualifiedPresence.json()).toEqual({ hasToken: true });
        expect(all.json()).toEqual({
            tokens: [{ vendor: "anthropic", hasToken: true }],
        });

        const legacyTupleWrite = await app.inject({
            method: "POST",
            url: "/v1/connect/openai/register",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: { token: "must-not-replace-anthropic" },
        });
        expect(legacyTupleWrite.statusCode).toBe(409);
        expect(legacyTupleWrite.json()).toEqual({
            error: "connect_credential_conflict",
        });

        const legacyTupleDelete = await app.inject({
            method: "DELETE",
            url: "/v1/connect/openai",
            headers: { "x-test-user-id": user.id },
        });
        expect(legacyTupleDelete.statusCode).toBe(200);
        expect(await db.serviceAccountToken.count({
            where: { accountId: user.id },
        })).toBe(1);
    });

    it("writes the released v1 service/profile through the canonical qualified identity", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-vendor-tokens-qualified-identity" },
            select: { id: true },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v1/connect/openai/register",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: { token: "sk-test" },
        });
        expect(register.statusCode).toBe(200);

        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai",
            profileId: "default",
        });
        const row = await db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai",
                    profileId: "default",
                },
            },
            select: {
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
                authenticationModeId: true,
            },
        });
        expect(row).toEqual(identity);
        await expect(listQualifiedConnectedAccounts({
            accountId: user.id,
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
        })).resolves.toMatchObject([{
            ref: {
                service: {
                    pluginId: identity.servicePluginId,
                    localId: identity.serviceLocalId,
                },
                accountId: "default",
            },
            authenticationModeId: "api-key",
            status: "needs_reauth",
        }]);

        const qualifiedCreate =
            await mutateQualifiedConnectedServiceCredential({
                accountId: user.id,
                ref: {
                    service: {
                        pluginId: identity.servicePluginId,
                        localId: identity.serviceLocalId,
                    },
                    accountId: "default",
                },
                authenticationModeId: identity.authenticationModeId,
                expectedCredentialRevision: null,
                content: { t: "encrypted", c: "qualified-ciphertext" },
                metadata: { scopes: [] },
            });
        expect(qualifiedCreate).toMatchObject({
            status: "superseded",
            reason: "credential_revision_mismatch",
        });
        expect(await db.serviceAccountToken.count({
            where: { accountId: user.id },
        })).toBe(1);
    });

    it("settles Claude v2/v3 credentials to the historical mode for each credential kind", async () => {
        const oauthUser = await db.account.create({
            data: { publicKey: "pk-claude-v2-oauth" },
            select: { id: true },
        });
        const tokenUser = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const oauthRegister = await app.inject({
            method: "POST",
            url: "/v2/connect/claude-subscription/profiles/default/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": oauthUser.id,
            },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "Y2xhdWRlLW9hdXRo",
                },
                metadata: { kind: "oauth" },
            },
        });
        expect(oauthRegister.statusCode).toBe(200);

        const now = Date.now();
        const tokenRegister = await app.inject({
            method: "POST",
            url: "/v3/connect/claude-subscription/profiles/default/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": tokenUser.id,
            },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "claude-subscription",
                        profileId: "default",
                        kind: "token",
                        createdAt: now,
                        updatedAt: now,
                        expiresAt: null,
                        oauth: null,
                        token: {
                            token: "claude-setup-token",
                            providerAccountId: null,
                            providerEmail: null,
                            raw: null,
                        },
                    },
                },
            },
        });
        expect(tokenRegister.statusCode).toBe(200);

        const rows = await db.serviceAccountToken.findMany({
            where: {
                accountId: {
                    in: [oauthUser.id, tokenUser.id],
                },
            },
            select: {
                accountId: true,
                authenticationModeId: true,
            },
        });
        expect(new Map(rows.map((row) => [
            row.accountId,
            row.authenticationModeId,
        ]))).toEqual(new Map([
            [oauthUser.id, "oauth"],
            [tokenUser.id, "setup-token"],
        ]));
    });

    it("preserves historical Gemini OAuth through v1/v2/v3 while marking its mode unsupported", async () => {
        const v1User = await db.account.create({
            data: { publicKey: "pk-gemini-old-oauth-v1" },
            select: { id: true },
        });
        const v2User = await db.account.create({
            data: { publicKey: "pk-gemini-old-oauth-v2" },
            select: { id: true },
        });
        const v3User = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const v1Write = await app.inject({
            method: "POST",
            url: "/v2/connect/gemini/profiles/default/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": v1User.id,
            },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "Z2VtaW5pLW9hdXRoLXYx",
                },
                metadata: {
                    kind: "oauth",
                    providerEmail: "old-v1@example.com",
                },
            },
        });
        expect(v1Write.statusCode).toBe(200);
        const v1CredentialRevision =
            (v1Write.json() as { credentialRevision: string })
                .credentialRevision;
        const v1Read = await app.inject({
            method: "GET",
            url: "/v1/connect/gemini/credential",
            headers: { "x-test-user-id": v1User.id },
        });
        expect(v1Read.statusCode).toBe(200);
        expect(v1Read.json()).toMatchObject({
            credentialRevision: v1CredentialRevision,
            sealed: {
                format: "account_scoped_v1",
                ciphertext: "Z2VtaW5pLW9hdXRoLXYx",
            },
            metadata: {
                kind: "oauth",
                providerEmail: "old-v1@example.com",
            },
        });

        const v2Write = await app.inject({
            method: "POST",
            url: "/v2/connect/gemini/profiles/old-oauth-v2/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": v2User.id,
            },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "Z2VtaW5pLW9hdXRoLXYy",
                },
                metadata: {
                    kind: "oauth",
                    providerEmail: "old-v2@example.com",
                },
            },
        });
        expect(v2Write.statusCode).toBe(200);
        const v2CredentialRevision =
            (v2Write.json() as { credentialRevision: string })
                .credentialRevision;
        const v2Read = await app.inject({
            method: "GET",
            url: "/v2/connect/gemini/profiles/old-oauth-v2/credential",
            headers: { "x-test-user-id": v2User.id },
        });
        expect(v2Read.statusCode).toBe(200);
        expect(v2Read.json()).toMatchObject({
            credentialRevision: v2CredentialRevision,
            sealed: {
                format: "account_scoped_v1",
                ciphertext: "Z2VtaW5pLW9hdXRoLXYy",
            },
            metadata: {
                kind: "oauth",
                providerEmail: "old-v2@example.com",
            },
        });

        const now = Date.now();
        const v3Record = {
            v: 1,
            serviceId: "gemini",
            profileId: "old-oauth-v3",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "old-gemini-access",
                refreshToken: "old-gemini-refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "old-v3@example.com",
                raw: null,
            },
            token: null,
        };
        const v3Write = await app.inject({
            method: "POST",
            url: "/v3/connect/gemini/profiles/old-oauth-v3/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": v3User.id,
            },
            payload: { content: { t: "plain", v: v3Record } },
        });
        expect(v3Write.statusCode).toBe(200);
        const v3CredentialRevision =
            (v3Write.json() as { credentialRevision: string })
                .credentialRevision;
        const v3Read = await app.inject({
            method: "GET",
            url: "/v3/connect/gemini/profiles/old-oauth-v3/credential",
            headers: { "x-test-user-id": v3User.id },
        });
        expect(v3Read.statusCode).toBe(200);
        expect(v3Read.json()).toMatchObject({
            credentialRevision: v3CredentialRevision,
            content: { t: "plain", v: v3Record },
        });

        const rows = await db.serviceAccountToken.findMany({
            where: {
                accountId: { in: [v1User.id, v2User.id, v3User.id] },
            },
            select: { authenticationModeId: true },
        });
        expect(rows).toHaveLength(3);
        expect(rows.every((row) =>
            row.authenticationModeId === "legacy-oauth-unsupported",
        )).toBe(true);
    });

    it("rejects v1 vendor token registration when a v2 connected service credential already exists", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u2" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const registerV2 = await app.inject({
            method: "POST",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "token", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(registerV2.statusCode).toBe(200);

        const legacyRegister = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "legacy-token" },
        });
        expect(legacyRegister.statusCode).toBe(409);
        expect(legacyRegister.json()).toEqual({ error: "connect_credential_conflict" });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: {
                token: true,
                metadata: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
                authenticationModeId: true,
            },
        });
        expect(row).not.toBeNull();
        expect(Buffer.from(row!.token).toString("utf8")).toContain('"c":"c2VhbGVk"');
        expect(row).toMatchObject(
            resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "anthropic",
                profileId: "default",
            }),
        );
    });

    it("rejects v1 vendor token registration without corrupting a v3 plaintext credential", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const now = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();
        const registerV3 = await app.inject({
            method: "POST",
            url: "/v3/connect/anthropic/profiles/default/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "anthropic",
                        profileId: "default",
                        kind: "token",
                        createdAt: now,
                        updatedAt: now,
                        expiresAt: null,
                        oauth: null,
                        token: {
                            token: "connected-token",
                            providerAccountId: "account-1",
                            providerEmail: "user@example.com",
                            raw: null,
                        },
                    },
                },
            },
        });
        expect(registerV3.statusCode).toBe(200);
        const before = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: {
                token: true,
                metadata: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
                authenticationModeId: true,
            },
        });
        expect(before).toMatchObject(
            resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "anthropic",
                profileId: "default",
            }),
        );
        const legacyRegister = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "legacy-token" },
        });
        expect(legacyRegister.statusCode).toBe(409);
        expect(legacyRegister.json()).toEqual({ error: "connect_credential_conflict" });
        const after = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: {
                token: true,
                metadata: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
                authenticationModeId: true,
            },
        });
        expect(after).toEqual(before);
    });

    it("treats v1 vendor token deletion as idempotent when the token is already missing", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u-missing" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const legacyDelete = await app.inject({
            method: "DELETE",
            url: "/v1/connect/openai",
            headers: { "x-test-user-id": user.id },
        });

        expect(legacyDelete.statusCode).toBe(200);
        expect(legacyDelete.json()).toEqual({ success: true });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai", profileId: "default" } },
        });
        expect(row).toBeNull();
    });

    it("rejects v1 vendor token deletion when a v2 connected service credential already exists", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u3" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const registerV2 = await app.inject({
            method: "POST",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "token", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(registerV2.statusCode).toBe(200);

        const legacyDelete = await app.inject({
            method: "DELETE",
            url: "/v1/connect/anthropic",
            headers: { "x-test-user-id": user.id },
        });
        expect(legacyDelete.statusCode).toBe(409);
        expect(legacyDelete.json()).toEqual({ error: "connect_credential_conflict" });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: { token: true, metadata: true },
        });
        expect(row).not.toBeNull();
        expect(Buffer.from(row!.token).toString("utf8")).toContain('"c":"c2VhbGVk"');
    });
});

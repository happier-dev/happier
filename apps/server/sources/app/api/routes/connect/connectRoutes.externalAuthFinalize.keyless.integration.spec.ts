import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { encryptString } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return trackApp(typed);
}

async function seedKeylessPending(pendingKey: string, proof: string): Promise<void> {
    const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");
    const githubProfile = { id: 123, login: "octocat", avatar_url: "", name: "The Octocat" };
    await db.repeatKey.create({
        data: {
            key: pendingKey,
            value: JSON.stringify({
                flow: "auth",
                provider: "github",
                authMode: "keyless",
                proofHash,
                profileEnc: privacyKit.encodeBase64(
                    encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                ),
                accessTokenEnc: privacyKit.encodeBase64(
                    encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], `tok_${pendingKey}`),
                ),
                suggestedUsername: "octocat",
                usernameRequired: false,
                usernameReason: null,
            }),
            expiresAt: new Date(Date.now() + 60_000),
        },
    });
}

describe("connectRoutes (external auth finalize keyless) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-external-finalize-keyless-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.userFeedItem.deleteMany();
        await db.userRelationship.deleteMany();
        await db.repeatKey.deleteMany();
        await db.uploadedFile.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless provisions a keyless account and returns a token when enabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const pendingKey = "oauth_pending_keylessA1";
        const proof = "proof_secret_1";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json).toMatchObject({ success: true });
        expect(typeof json.token).toBe("string");

        const accounts = await db.account.findMany({ select: { id: true, publicKey: true, encryptionMode: true } });
        expect(accounts.length).toBe(1);
        expect(accounts[0].publicKey).toBeNull();
        expect(accounts[0].encryptionMode).toBe("plain");

        const identities = await db.accountIdentity.findMany({
            where: { provider: "github", providerUserId: "123" },
            select: { accountId: true },
        });
        expect(identities.length).toBe(1);
        expect(identities[0].accountId).toBe(accounts[0].id);

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless hands every sign-in of a keyless account the same content keypair", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const finalize = async (pendingKey: string, proof: string) => {
            await seedKeylessPending(pendingKey, proof);
            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize-keyless",
                headers: { "content-type": "application/json" },
                payload: { pending: pendingKey, proof },
            });
            expect(res.statusCode).toBe(200);
            return res.json();
        };

        // First sign-in provisions the account; the second resolves the linked identity.
        const first = await finalize("oauth_pending_keylessK1", "proof_k1");
        const second = await finalize("oauth_pending_keylessK2", "proof_k2");
        expect(await db.account.count()).toBe(1);

        expect(first.content).toEqual({ publicKey: expect.any(String), machineKey: expect.any(String) });
        expect(second.content).toEqual(first.content);
        const machineKey = privacyKit.decodeBase64(first.content.machineKey);
        expect(machineKey.length).toBe(32);
        expect(privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey)))
            .toBe(first.content.publicKey);
    });

    it("POST /v1/auth/external/:provider/finalize-keyless returns 409 restore-required when the external identity is linked to a keyed account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });

        const keyedAccount = await db.account.create({
            data: { publicKey: "pk_hex_1", encryptionMode: "e2ee" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: keyedAccount.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                showOnProfile: false,
            },
        });

        const pendingKey = "oauth_pending_keylessB1";
        const proof = "proof_secret_2";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "restore-required" });

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless succeeds when the external identity is linked to a keyed-but-plain account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });

        const keyedPlainAccount = await db.account.create({
            data: { publicKey: "pk_hex_2", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: keyedPlainAccount.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                showOnProfile: false,
            },
        });

        const pendingKey = "oauth_pending_keylessB2";
        const proof = "proof_secret_2b";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_2b"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json).toMatchObject({ success: true });
        expect(typeof json.token).toBe("string");

        // A keyed account keeps its own key material; only keyless accounts get the account content key.
        expect(json.content).toBeUndefined();

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless returns 403 e2ee-required when server storagePolicy=required_e2ee", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        });

        const keylessAccount = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: keylessAccount.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                showOnProfile: false,
            },
        });

        const pendingKey = "oauth_pending_keylessC1";
        const proof = "proof_secret_3";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_3"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "e2ee-required" });

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });
});

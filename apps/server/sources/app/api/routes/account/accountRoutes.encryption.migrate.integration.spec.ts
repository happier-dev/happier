import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

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

    return typed;
}

describe("registerAccountEncryptionMigrateRoutes (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-migrate-",
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.automation.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("migrates e2ee -> plain atomically and stores v2 settings in plaintext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-migrate-1", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "plain" });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(typeof storedAccount?.settings).toBe("string");
        expect((storedAccount?.settings ?? "").includes("ciphertext")).toBe(false);

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({ version: 1, content: { t: "plain" } });

        await app.close();
    });

    it("stores v2 settings sealed at rest for plain accounts when configured", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "server_sealed",
        });

        const kp = tweetnacl.sign.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(kp.publicKey));

        const account = await db.account.create({
            data: { publicKey: publicKeyHex, encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const migrate = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2, pushEnabled: true } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });

        expect(migrate.statusCode).toBe(200);
        expect(migrate.json()).toMatchObject({ success: true, mode: "plain", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true, publicKey: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.publicKey).toBe(publicKeyHex);
        expect(typeof storedAccount?.settings).toBe("string");
        const wrapper = JSON.parse(storedAccount?.settings ?? "{}") as any;
        expect(wrapper?.t).toBe("sealed_v1");

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({
            version: 1,
            content: { t: "plain", v: expect.objectContaining({ schemaVersion: 2, pushEnabled: true }) },
        });

        await app.close();
    });

    it("does not allow rotating the account signing key across encryption-mode toggles", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const kp1 = tweetnacl.sign.keyPair();
        const kp2 = tweetnacl.sign.keyPair();
        const publicKeyHex1 = privacyKit.encodeHex(new Uint8Array(kp1.publicKey));

        const account = await db.account.create({
            data: { publicKey: publicKeyHex1, encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const toPlain = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });
        expect(toPlain.statusCode).toBe(200);

        const storedAfterPlain = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settingsVersion: true },
        });
        expect(storedAfterPlain?.encryptionMode).toBe("plain");
        expect(storedAfterPlain?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterPlain?.settingsVersion).toBe(1);

        const challenge2 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature2 = Uint8Array.from(tweetnacl.sign.detached(challenge2, Uint8Array.from(kp2.secretKey)));
        const mismatchedKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp2.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge2),
                    signature: privacyKit.encodeBase64(signature2),
                },
            },
        });
        expect(mismatchedKey.statusCode).toBe(400);
        expect(mismatchedKey.json()).toEqual({ error: "invalid-params", reason: "restore_required" });

        const challenge1 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature1 = Uint8Array.from(tweetnacl.sign.detached(challenge1, Uint8Array.from(kp1.secretKey)));
        const correctKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp1.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge1),
                    signature: privacyKit.encodeBase64(signature1),
                },
            },
        });
        expect(correctKey.statusCode).toBe(200);
        expect(correctKey.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 2 });

        const storedAfterE2ee = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settings: true, settingsVersion: true },
        });
        expect(storedAfterE2ee?.encryptionMode).toBe("e2ee");
        expect(storedAfterE2ee?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterE2ee?.settings).toBe("settings-ciphertext");
        expect(storedAfterE2ee?.settingsVersion).toBe(2);

        await app.close();
    });

    it("migrates plain -> e2ee atomically and requires keyProof", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain", settings: null, settingsVersion: 0 },
            select: { id: true },
        });

        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "a1",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { v: 1 } }),
            },
            select: { id: true },
        });

        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                token: new TextEncoder().encode("{\"kind\":\"oauth\"}"),
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const missingProof = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });
        expect(missingProof.statusCode).toBe(400);
        expect(missingProof.json()).toEqual({ error: "invalid-params", reason: "key_proof_required" });

        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const secretKey = Uint8Array.from(kp.secretKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));

        const encryptedTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "tpl-ciphertext",
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: {
                    action: "migrate",
                    credentials: [
                        {
                            serviceId: "openai-codex",
                            profileId: "work",
                            kind: "sealed",
                            sealed: { format: "account_scoped_v1", ciphertext: "cred-ciphertext" },
                            metadata: { kind: "oauth", providerEmail: "x@example.com", providerAccountId: "acct", expiresAt: null },
                        },
                    ],
                },
                automations: {
                    action: "migrate",
                    templates: [{ automationId: automation.id, templateCiphertext: encryptedTemplateCiphertext }],
                },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(publicKey),
                    challenge: privacyKit.encodeBase64(challenge),
                    signature: privacyKit.encodeBase64(signature),
                },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settings: true, settingsVersion: true },
        });
        expect(storedAccount?.encryptionMode).toBe("e2ee");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.settings).toBe("settings-ciphertext");
        expect(typeof storedAccount?.publicKey).toBe("string");
        expect((storedAccount?.publicKey ?? "").length).toBeGreaterThan(0);

        const tokenRow = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "openai-codex", profileId: "work" } },
            select: { token: true, metadata: true },
        });
        expect(tokenRow?.token?.byteLength).toBeGreaterThan(0);
        expect((tokenRow?.metadata as any)?.v).toBe(2);
        expect((tokenRow?.metadata as any)?.format).toBe("account_scoped_v1");

        const updatedAutomation = await db.automation.findUnique({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        });
        expect(updatedAutomation?.templateCiphertext).toBe(encryptedTemplateCiphertext);

        await app.close();
    });
});

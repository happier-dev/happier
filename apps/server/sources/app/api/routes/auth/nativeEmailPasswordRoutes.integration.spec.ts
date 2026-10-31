import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptPasswordTextV1, encodePasswordCredentialFieldV1, NativeEmailPasswordPreloginResponseV1Schema,
    PASSWORD_ENVELOPE_SUPPORTED_WRITER_PROFILES_V1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { hashPasswordMaterial, passwordHashAdmission } from "@/app/auth/password/passwordMaterialVerifier";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { resolveEffectiveHomeAuthMethods } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";

describe("native password authentication through the registered method", () => {
    let harness: LightSqliteHarness;
    const password = "correct password with spaces";
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-native-password-routes-", initAuth: true,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true", AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1", HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                // Unlock issues the Account-bound Key Challenge it just verified the
                // password for, so this fixture needs the same stable audience and
                // server identity any Home that can complete Key Challenge V2 has.
                HAPPIER_CANONICAL_SERVER_URL: "https://native-password.example.test",
                HAPPIER_SERVER_IDENTITY_ID: "srv_native_password_home" },
        });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("preserves existing-Account login when Home policy narrows future provisioning modes", async () => {
        const accepted = acceptPasswordTextV1(password);
        if (!accepted.accepted) throw new Error("invalid test password");
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: "mode-policy@example.test",
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(accepted.utf8) },
        } });
        await db.homeGovernancePolicy.create({ data: {
            id: "home", authenticationPolicy: { v: 1, permittedAccountModes: ["e2ee"] },
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const plain = await app.inject({ method: "POST", url: "/v1/auth/email/login",
                payload: { v: 1, email: "mode-policy@example.test", password } });
            expect(plain.statusCode, plain.body).toBe(200);
            expect(plain.json()).toEqual({ token: expect.any(String) });
        } finally {
            await db.homeGovernancePolicy.deleteMany({});
            await db.account.delete({ where: { id: account.id } });
            await app.close();
        }
    });

    it("enforces persisted Home method disablement at every native authentication entry point", async () => {
        await db.homeGovernancePolicy.create({ data: {
            id: "home", authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const effective = await resolveEffectiveHomeAuthMethods({ env: process.env });
            expect(effective.status).toBe("ready");
            if (effective.status !== "ready") throw new Error("Home policy unavailable");
            expect(effective.decisions.find(({ id }) => id === "email_password")?.actions
                .some(({ enabled }) => enabled)).toBe(false);
            for (const [operation, payload] of [
                ["login", { password }],
                ["unlock", { authKey: encodePasswordCredentialFieldV1(new Uint8Array(32)) }],
                ["prelogin", {}],
            ] as const) {
                const response = await app.inject({ method: "POST", url: `/v1/auth/email/${operation}`,
                    payload: { v: 1, email: "policy@example.test", ...payload } });
                expect(response.statusCode, operation).toBe(403);
                expect(response.json()).toEqual({ error: "method_not_available" });
            }
        } finally {
            await db.homeGovernancePolicy.deleteMany({});
            await app.close();
        }
    });

    it("authenticates an exact native locator with a token-only credential and discloses disablement only after proof", async () => {
        const accepted = acceptPasswordTextV1(password);
        if (!accepted.accepted) throw new Error("invalid test password");
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: "alice@example.test", profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(accepted.utf8) },
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const login = (email: string, candidate = password) => app.inject({
                method: "POST", url: "/v1/auth/email/login", payload: { v: 1, email, password: candidate },
            });
            const response = await login(" ALICE@EXAMPLE.TEST ");
            expect(response.statusCode, response.statusCode >= 400 ? response.body : undefined).toBe(200);
            expect(response.json()).toEqual({ token: expect.any(String) });
            expect(await auth.verifyToken(response.json().token)).toMatchObject({
                userId: account.id, authTokenKind: "account", authority: "present_user",
            });
            const terminal = await app.inject({ method: "POST", url: "/v1/auth/email/login",
                payload: { v: 1, email: "alice@example.test", password, credentialKind: "terminal" } });
            expect(terminal.statusCode, terminal.statusCode >= 400 ? terminal.body : undefined).toBe(200);
            expect(await auth.verifyToken(terminal.json().token)).toMatchObject({
                userId: account.id, authTokenKind: "terminal",
            });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
                encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
            });
            const wrong = await login("alice@example.test", "different password with spaces");
            const unknown = await login("unknown@example.test");
            expect(wrong.statusCode).toBe(401);
            expect(unknown.statusCode).toBe(401);
            expect(unknown.json()).toEqual(wrong.json());
            await db.account.update({ where: { id: account.id }, data: { status: "disabled" } });
            expect((await login("alice@example.test", "different password with spaces")).json()).toEqual(wrong.json());
            const disabled = await login("alice@example.test");
            expect(disabled.statusCode).toBe(403);
            expect(disabled.json()).toEqual({ error: "account-disabled" });
        } finally { await app.close(); }
    });

    it("mints an Account Directory credential for a Plain password login only where this server is an Account Service", async () => {
        const accepted = acceptPasswordTextV1(password);
        if (!accepted.accepted) throw new Error("invalid test password");
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: "directory@example.test", profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(accepted.utf8) },
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const login = (candidate = password) => app.inject({
                method: "POST", url: "/v1/auth/email/login",
                payload: { v: 1, email: "directory@example.test", password: candidate, credentialTarget: "account_directory", credentialKind: "terminal" },
            });
            const response = await login();
            expect(response.statusCode, response.body).toBe(200);
            expect(await auth.verifyToken(response.json().token)).toMatchObject({
                userId: account.id, authTokenKind: "account_directory", authority: "present_user",
            });
            const wrong = await login("different password with spaces");
            expect(wrong.statusCode).toBe(401);
            expect(wrong.json()).toEqual({ error: "authentication_failed" });
            // Without the Account Directory capability (no master secret) the
            // server is not an Account Service and must not mint the restricted kind.
            delete process.env.HANDY_MASTER_SECRET;
            const refused = await login();
            expect(refused.statusCode).toBe(403);
            expect(refused.json()).toEqual({ error: "method_not_available" });
        } finally {
            harness.resetEnv();
            await db.account.delete({ where: { id: account.id } });
            await app.close();
        }
    });

    it("releases an E2EE envelope only after its derived key proves the current signing-bound credential", async () => {
        const signing = tweetnacl.sign.keyPair();
        const authKey = new Uint8Array(32).fill(71);
        const envelope = {
            v: 1 as const, accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
            kdf: { algorithm: "argon2id13" as const, salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(23)),
                opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 as const },
            cipher: { algorithm: "aes256gcm" as const, nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(11)),
                ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(17)) },
        };
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee", publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: "encrypted@example.test", profile: {},
        } });
        const credential = { v: 1, kind: "e2ee_password_envelope", envelope,
            authVerifier: { v: 1, hash: await hashPasswordMaterial(authKey) } };
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const unlock = (email: string, key = authKey) => app.inject({ method: "POST", url: "/v1/auth/email/unlock",
                payload: { v: 1, email, authKey: encodePasswordCredentialFieldV1(key) } });
            const response = await unlock("encrypted@example.test");
            expect(response.statusCode, response.statusCode >= 400 ? response.body : undefined).toBe(200);
            expect(response.json()).toMatchObject({
                envelope,
                expectedAccountId: account.id,
                challenge: { challengeId: expect.any(String) },
            });
            const wrong = await unlock("encrypted@example.test", new Uint8Array(32));
            expect(wrong.statusCode).toBe(401);
            expect((await unlock("unknown@example.test")).json()).toEqual(wrong.json());
            await db.account.update({ where: { id: account.id }, data: { status: "disabled" } });
            expect((await unlock("encrypted@example.test", new Uint8Array(32))).json()).toEqual(wrong.json());
            const disabled = await unlock("encrypted@example.test");
            expect(disabled.statusCode).toBe(403);
            expect(disabled.json()).toEqual({ error: "account-disabled" });
            await db.account.update({ where: { id: account.id }, data: { status: "active" } });
            await db.accountPasswordCredential.update({ where: { accountId: account.id }, data: {
                credential: { ...credential, envelope: { ...envelope,
                    accountSigningPublicKey: encodePasswordCredentialFieldV1(tweetnacl.sign.keyPair().publicKey) } },
            } });
            expect((await unlock("encrypted@example.test")).json()).toEqual(wrong.json());
        } finally { await app.close(); }
    });

    it("rechecks current password-login policy after derived-key work before releasing an envelope or challenge", async () => {
        const signing = tweetnacl.sign.keyPair();
        const authKey = new Uint8Array(32).fill(72);
        const envelope = {
            v: 1 as const,
            accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
            kdf: {
                algorithm: "argon2id13" as const,
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(24)),
                opsLimit: 3,
                memLimitBytes: 64 * 1024 * 1024,
                outputBytes: 32 as const,
            },
            cipher: {
                algorithm: "aes256gcm" as const,
                nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(12)),
                ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(18)),
            },
        };
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: "policy-race@example.test",
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: {
                v: 1,
                kind: "e2ee_password_envelope",
                envelope,
                authVerifier: { v: 1, hash: await hashPasswordMaterial(authKey) },
            },
        } });

        let releasePasswordWork = () => {};
        const passwordWorkGate = new Promise<void>((resolve) => { releasePasswordWork = resolve; });
        const admission = passwordHashAdmission();
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        const holders = Array.from({ length: admission.maxConcurrent }, () => admission.run(() => passwordWorkGate));
        try {
            const pending = app.inject({
                method: "POST",
                url: "/v1/auth/email/unlock",
                payload: {
                    v: 1,
                    email: "policy-race@example.test",
                    authKey: encodePasswordCredentialFieldV1(authKey),
                },
            });
            await vi.waitFor(() => expect(admission.inspect().queued).toBe(1));
            await db.homeGovernancePolicy.create({
                data: {
                    id: "home",
                    authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
                },
            });
            releasePasswordWork();

            const response = await pending;
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "method_not_available" });
            expect(response.body).not.toContain("envelope");
            expect(await db.keyChallengeV2.count({
                where: { expectedAccountId: account.id },
            })).toBe(0);
        } finally {
            releasePasswordWork();
            await Promise.all(holders);
            await db.homeGovernancePolicy.deleteMany({});
            await app.close();
        }
    });

    it("releases the E2EE envelope when the Key Challenge method's own login policy is disabled", async () => {
        // The finalizer qualifies a password-stamped challenge as
        // `email_password` and gates on that method's decision
        // (`registerKeyChallengeAuthRoute.ts`), so `key_challenge` policy does
        // not bound keyed password login. Refusing here would let a Home create
        // E2EE password Accounts it then refuses to sign in.
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
        const signing = tweetnacl.sign.keyPair();
        const authKey = new Uint8Array(32).fill(73);
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: "keyed-disabled@example.test",
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: {
                v: 1,
                kind: "e2ee_password_envelope",
                envelope: {
                    v: 1,
                    accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
                    kdf: {
                        algorithm: "argon2id13",
                        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(25)),
                        opsLimit: 3,
                        memLimitBytes: 64 * 1024 * 1024,
                        outputBytes: 32,
                    },
                    cipher: {
                        algorithm: "aes256gcm",
                        nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(13)),
                        ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(19)),
                    },
                },
                authVerifier: { v: 1, hash: await hashPasswordMaterial(authKey) },
            },
        } });

        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/email/unlock",
                payload: {
                    v: 1,
                    email: "keyed-disabled@example.test",
                    authKey: encodePasswordCredentialFieldV1(authKey),
                },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                expectedAccountId: account.id,
                challenge: { challengeId: expect.any(String) },
            });
            await expect(db.keyChallengeV2.count({
                where: { expectedAccountId: account.id },
            })).resolves.toBe(1);
        } finally {
            harness.resetEnv();
            await db.keyChallengeV2.deleteMany({ where: { expectedAccountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
            await app.close();
        }
    });

    it("returns bounded, deterministic prelogin routing without disclosing an envelope, Account identity, or status", async () => {
        const signing = tweetnacl.sign.keyPair();
        const envelope = {
            v: 1 as const, accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
            kdf: { algorithm: "argon2id13" as const, salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(33)),
                opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 as const },
            cipher: { algorithm: "aes256gcm" as const, nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(21)),
                ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(27)) },
        };
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee", publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: "routing@example.test", profile: {},
        } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: {
            v: 1, kind: "e2ee_password_envelope", envelope,
            authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32).fill(81)) },
        } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const prelogin = (email: string) => app.inject({ method: "POST", url: "/v1/auth/email/prelogin", payload: { v: 1, email } });
            const response = await prelogin("routing@example.test");
            expect(response.statusCode, response.statusCode >= 400 ? response.body : undefined).toBe(200);
            expect(response.json()).toEqual({ v: 1, kind: "e2ee_password_unlock", kdf: envelope.kdf });
            await db.account.update({ where: { id: account.id }, data: { status: "disabled" } });
            expect((await prelogin("routing@example.test")).json()).toEqual(response.json());
            const unknown = await prelogin("not-enrolled@example.test");
            expect(unknown.statusCode).toBe(200);
            expect(NativeEmailPasswordPreloginResponseV1Schema.safeParse(unknown.json()).success).toBe(true);
            expect((await prelogin(" NOT-ENROLLED@EXAMPLE.TEST ")).json()).toEqual(unknown.json());
            // Every decoy that routes to the encrypted branch must advertise a
            // profile a real writer could have written. Sourcing it from the
            // schema's admission floor instead would let anyone separate absent
            // Accounts from enrolled ones by comparing KDF parameters alone.
            const supported = PASSWORD_ENVELOPE_SUPPORTED_WRITER_PROFILES_V1
                .map((profile) => JSON.stringify(profile));
            let observedDecoys = 0;
            for (let index = 0; index < 40; index += 1) {
                const decoy = NativeEmailPasswordPreloginResponseV1Schema.parse(
                    (await prelogin(`absent-${index}@example.test`)).json(),
                );
                if (decoy.kind !== "e2ee_password_unlock") continue;
                observedDecoys += 1;
                const { salt, ...profile } = decoy.kdf;
                expect(salt.length).toBeGreaterThan(0);
                expect(supported, `decoy ${index}`).toContain(JSON.stringify(profile));
            }
            expect(observedDecoys).toBeGreaterThan(0);
            process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "false";
            expect((await prelogin("routing@example.test")).statusCode).toBe(403);
        } finally { harness.resetEnv(); await app.close(); }
    });
});

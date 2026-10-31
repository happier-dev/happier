import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { hashPasswordMaterial, passwordHashAdmission, verifyPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { parseAccountPasswordCredentialV1, type E2eeAccountPasswordCredentialV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { inTx } from "@/storage/inTx";
import { issueNativeAuthOneTimeOperationInTx, readNativeAuthOneTimeOperation } from "@/app/auth/email/nativeAuthOneTimeOperations";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1, createPasswordMutationChallengeSigningInputV1, encodePasswordCredentialFieldV1 } from "@happier-dev/protocol";
import { issuePasswordMutationKeyChallengeV1 } from "@/app/auth/keyChallengeV2";
import { registerAccountSecurityRoutes } from "./registerAccountSecurityRoutes";
import { createHash } from "node:crypto";
import { createMtlsClaimCode } from "@/app/auth/providers/mtls/mtlsClaimCode";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { setTeamPolicyInTx } from "@/app/teams/policy";
import { registerAuthEntryRoute } from "./registerAuthEntryRoute";
import { ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1 } from "@happier-dev/protocol";

describe("Account Security native password lifecycle", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "account-security-", initAuth: true,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true", AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_FEATURE_TEAMS__ENABLED: "true",
                HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "true",
                HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "true",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "true",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_SERVER_IDENTITY_ID: "srv_security_home" } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("maps real password-hash admission pressure to a retryable failure after reading the Home settings", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const admission = passwordHashAdmission();
        let releaseSlot = () => {};
        const held = new Promise<void>((resolve) => { releaseSlot = resolve; });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app);
        const holders = Array.from({ length: admission.maxConcurrent + admission.maxQueued }, () => admission.run(() => held));
        try {
            const response = await app.inject({ method: "POST", url: ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
                headers: { authorization: `Bearer ${token}` }, payload: {
                    v: 1, action: "change", expectedCredentialRevision: 1,
                    normalizedNativeEmail: "alice@example.test", newPlainPassword: "replacement password value",
                } });
            expect(response.statusCode, response.body).toBe(503);
            expect(response.json()).toEqual({ error: "password_hash_overloaded" });
        } finally {
            releaseSlot();
            await Promise.all(holders);
            await app.close();
        }
    });

    it("does not relabel a persistence transaction failure as an invalid password-reset bearer", async () => {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app);
        // SQLite read-only snapshots keep the Home read real; only the write
        // transaction persistence boundary fails, as it can under contention.
        const originalTransaction = db.$transaction;
        db.$transaction = (async () => { throw new Error("database is locked"); }) as typeof db.$transaction;
        try {
            const response = await app.inject({ method: "POST", url: NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1,
                payload: { v: 1, token: "A".repeat(43), password: "replacement password value" } });
            expect(response.statusCode, response.body).toBe(500);
            expect(response.json()).not.toMatchObject({ error: "invalid_reset" });
        } finally {
            db.$transaction = originalTransaction;
            await app.close();
        }
    });

    it("lets a terminal credential read a re-allowed policy under its stale automation ceiling", async () => {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            terminalPresentUserPolicy: "allowed",
        } });
        const token = await auth.createToken(account.id, undefined, { kind: "terminal", authority: "account_automation" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app);
        try {
            const response = await app.inject({ method: "GET", url: "/v1/account/security", headers: {
                authorization: `Bearer ${token}`, "x-happier-authority-ceiling": "account_automation",
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ terminalPresentUserPolicy: "allowed" });
        } finally { await app.close(); }
    });

    it("enrolls an E2EE Account with no native identity only after exact mailbox verification", async () => {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const delivered: string[] = [];
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app, {
            authEmailDelivery: { isReady: async () => true, deliver: async (message) => {
                if (message.kind === "native_email_verification") delivered.push(message.verifyUrl);
                return { status: "sent" };
            } },
            isEmailDeliveryReady: () => true,
            resolveApplicationLinkTarget: async () => ({ applicationOrigin: "https://app.example.test", homeTarget: "home", serverId: "home" }),
        });
        await app.ready();
        const email = "new-e2ee-email@example.test";
        const field = (length: number, fill = 0) => encodePasswordCredentialFieldV1(new Uint8Array(length).fill(fill));
        const targetCredential: E2eeAccountPasswordCredentialV1 = {
            v: 1 as const, kind: "e2ee_password_envelope" as const,
            authVerifier: { v: 1 as const, hash: await hashPasswordMaterial(new Uint8Array(32).fill(8)) },
            envelope: {
                v: 1 as const,
                accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
                kdf: { algorithm: "argon2id13" as const, salt: field(16, 1), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm" as const, nonce: field(12, 2), ciphertext: field(48, 3) },
            },
        };
        const challenge = await issuePasswordMutationKeyChallengeV1({ env: process.env, mutation: {
            v: 1, action: "connect", accountId: account.id, expectedCredentialRevision: null,
            normalizedNativeEmail: email,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
        } });
        if (!challenge) throw new Error("challenge unavailable");
        const proof = {
            challengeId: challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(challenge), signing.secretKey,
            ))),
        };
        const headers = { authorization: `Bearer ${token}` };
        try {
            const withoutMailbox = await app.inject({ method: "POST", url: "/v1/account/password/enroll", headers,
                payload: { v: 1, kind: "e2ee", email, targetCredential, proof } });
            expect(withoutMailbox.statusCode).toBe(401);
            const requested = await app.inject({ method: "POST", url: "/v1/account/password/enroll/email/request", headers,
                payload: { v: 1, email } });
            expect(requested.statusCode, requested.body).toBe(200);
            expect(delivered).toHaveLength(1);
            const verificationToken = new URL(delivered[0]!).pathname.split("/").at(-1)!;
            const enrolled = await app.inject({ method: "POST", url: "/v1/account/password/enroll", headers,
                payload: { v: 1, kind: "e2ee", email, targetCredential, proof, verificationToken } });
            expect(enrolled.statusCode, enrolled.body).toBe(200);
            expect(await db.accountEmail.findUnique({ where: { accountId_normalizedEmail: {
                accountId: account.id, normalizedEmail: email,
            } } })).not.toBeNull();
            expect(await db.accountIdentity.findUnique({ where: { accountId_provider: {
                accountId: account.id, provider: "email",
            } } })).toMatchObject({ providerUserId: email });
            expect(await db.accountPasswordCredential.findUnique({ where: { accountId: account.id } })).not.toBeNull();
        } finally { await app.close(); }
    });

    it("rejects an E2EE password change whose envelope belongs to another signing key without consuming proof", async () => {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        const email = "e2ee-binding@example.test";
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: email,
            profile: {},
        } });
        const field = (length: number, fill = 0) => encodePasswordCredentialFieldV1(new Uint8Array(length).fill(fill));
        const credential = async (accountSigningPublicKey: string, fill: number): Promise<E2eeAccountPasswordCredentialV1> => ({
            v: 1,
            kind: "e2ee_password_envelope",
            authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32).fill(fill)) },
            envelope: {
                v: 1,
                accountSigningPublicKey,
                kdf: { algorithm: "argon2id13", salt: field(16, fill), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: field(12, fill), ciphertext: field(48, fill) },
            },
        });
        const currentCredential = await credential(
            encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            4,
        );
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: currentCredential } });
        const targetCredential = await credential(field(32, 9), 9);
        const mutation = {
            v: 1 as const,
            action: "change" as const,
            accountId: account.id,
            expectedCredentialRevision: 1,
            normalizedNativeEmail: email,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
        };
        const challenge = await issuePasswordMutationKeyChallengeV1({ env: process.env, mutation });
        if (!challenge) throw new Error("challenge unavailable");
        const proof = {
            challengeId: challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(challenge),
                signing.secretKey,
            ))),
        };
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/password/change",
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, kind: "e2ee", action: "change", expectedCredentialRevision: 1, targetCredential, proof },
            });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toEqual({ error: "credential_inconsistent" });
            expect(await db.keyChallengeV2.findUniqueOrThrow({ where: { id: challenge.challengeId } })).toMatchObject({ consumedAt: null });
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } })).toMatchObject({
                revision: 1,
                credential: currentCredential,
            });
        } finally { await app.close(); }
    });

    it("enrolls a Plain password only with a purpose-bound current mTLS proof and commits identity plus credential together", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const email = "plain-enrollment@example.test";
        const substitutedEmail = "plain-enrollment-substituted@example.test";
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "mtls",
            providerUserId: "current-mtls-subject",
            profile: {},
        } });
        await db.accountEmail.create({ data: { accountId: account.id, normalizedEmail: substitutedEmail, address: substitutedEmail } });
        const verificationOperation = await inTx(tx => issueNativeAuthOneTimeOperationInTx(tx, {
            v: 1,
            purpose: "verify_native_email",
            normalizedEmail: email,
            consumer: { kind: "password_enrollment", accountId: account.id },
        }));
        const targetCredential = {
            v: 1 as const,
            kind: "plain_password_hash" as const,
            hash: await hashPasswordMaterial(new TextEncoder().encode("newly enrolled password value")),
        };
        const requestDigest = createPasswordCredentialMutationDigestV1({
            v: 1,
            action: "connect",
            accountId: account.id,
            expectedCredentialRevision: null,
            normalizedNativeEmail: email,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
        });
        const browserProof = "purpose-bound-enrollment-proof";
        const pending = await createMtlsClaimCode({
            userId: account.id,
            ttlMs: 60_000,
            stepUp: {
                purpose: "account_password_enrollment",
                providerUserId: "current-mtls-subject",
                proofHash: createHash("sha256").update(browserProof, "utf8").digest("hex"),
                requestDigest,
            },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "mtls" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const enroll = (candidateEmail: string, candidateCredential = targetCredential) => app.inject({
                method: "POST",
                url: "/v1/account/password/enroll",
                headers: { authorization: `Bearer ${token}` },
                payload: {
                    v: 1,
                    kind: "plain",
                    email: candidateEmail,
                    targetCredential: candidateCredential,
                    verificationToken: verificationOperation.rawBearer,
                    reauthentication: { provider: "mtls", pending, proof: browserProof },
                },
            });
            const substitutedEmailResponse = await enroll(substitutedEmail);
            expect(substitutedEmailResponse.statusCode, substitutedEmailResponse.body).toBe(401);
            expect(await db.repeatKey.findUnique({ where: { key: `mtls_claim_${pending}` } })).not.toBeNull();
            expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, {
                purpose: "verify_native_email",
                token: verificationOperation.rawBearer,
            }))).not.toBeNull();
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(0);
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(0);

            const substitutedCredentials = [
                {
                    ...targetCredential,
                    hash: {
                        ...targetCredential.hash,
                        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(6)),
                    },
                },
                {
                    ...targetCredential,
                    hash: {
                        ...targetCredential.hash,
                        digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(7)),
                    },
                },
                {
                    ...targetCredential,
                    hash: {
                        ...targetCredential.hash,
                        parameters: { n: 2 ** 15, r: 8 as const, p: 3, keyLength: 32 as const },
                    },
                },
            ];
            for (const substitutedCredential of substitutedCredentials) {
                const substitutedCredentialResponse = await enroll(email, substitutedCredential);
                expect(substitutedCredentialResponse.statusCode, substitutedCredentialResponse.body).toBe(401);
                expect(await db.repeatKey.findUnique({ where: { key: `mtls_claim_${pending}` } })).not.toBeNull();
                expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, {
                    purpose: "verify_native_email",
                    token: verificationOperation.rawBearer,
                }))).not.toBeNull();
                expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(0);
                expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(0);
            }

            const response = await enroll(email);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ v: 1, status: "enrolled" });
            expect(await db.accountIdentity.findUniqueOrThrow({
                where: { accountId_provider: { accountId: account.id, provider: "email" } },
            })).toMatchObject({ providerUserId: email, providerLogin: null, showOnProfile: false });
            const stored = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(stored.revision).toBe(1);
            expect(parseAccountPasswordCredentialV1("plain", stored.credential)).toMatchObject({ ok: true, mode: "plain" });
            expect(stored.credential).toEqual(targetCredential);
            expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, {
                purpose: "verify_native_email",
                token: verificationOperation.rawBearer,
            }))).toBeNull();
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "mtls" } })).toBe(1);
        } finally { await app.close(); }
    });

    it("returns the canonical typed inconsistency when enrollment targets the wrong Account mode", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "mtls" }] });
        const field = (length: number) => encodePasswordCredentialFieldV1(new Uint8Array(length));
        const targetCredential = {
            v: 1 as const,
            kind: "e2ee_password_envelope" as const,
            authVerifier: { v: 1 as const, hash: await hashPasswordMaterial(new Uint8Array(32)) },
            envelope: {
                v: 1 as const,
                accountSigningPublicKey: field(32),
                kdf: { algorithm: "argon2id13" as const, salt: field(16), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm" as const, nonce: field(12), ciphertext: field(48) },
            },
        };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/password/enroll",
                headers: { authorization: `Bearer ${token}` },
                payload: {
                    v: 1,
                    kind: "e2ee",
                    email: "wrong-mode@example.test",
                    targetCredential,
                    proof: { challengeId: "not-consumed", publicKey: field(32), signature: field(64) },
                },
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "credential_inconsistent" });
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(0);
        } finally { await app.close(); }
    });

    it("fails closed when the persisted Account mode is outside the supported domain", async () => {
        const account = await db.account.create({ data: { encryptionMode: "unsupported", publicKey: null } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "mtls" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const response = await app.inject({ method: "GET", url: "/v1/account/security",
                headers: { authorization: `Bearer ${token}` } });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "credential_inconsistent" });
        } finally { await app.close(); }
    });

    it("preserves an E2EE removal proof on login-stranding rejection, then removes only after viability succeeds", async () => {
        const signing = tweetnacl.sign.keyPair();
        const publicKey = privacyKit.encodeHex(new Uint8Array(signing.publicKey));
        const account = await db.account.create({ data: { encryptionMode: "e2ee", publicKey } });
        const email = "e2ee-security@example.test";
        await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: email, profile: {} } });
        await db.accountEmail.create({ data: { accountId: account.id, normalizedEmail: email, address: email } });
        const field = (length: number) => encodePasswordCredentialFieldV1(new Uint8Array(length));
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: {
            v: 1, kind: "e2ee_password_envelope", authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32)) },
            envelope: { v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
                kdf: { algorithm: "argon2id13", salt: field(16), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: field(12), ciphertext: field(48) } },
        } } });
        const challenge = await issuePasswordMutationKeyChallengeV1({ env: process.env, mutation: {
            v: 1, action: "remove", accountId: account.id, expectedCredentialRevision: 1,
            normalizedNativeEmail: email, newCredentialDigest: null,
        } });
        if (!challenge) throw new Error("challenge unavailable");
        const proof = { challengeId: challenge.challengeId, publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(createPasswordMutationChallengeSigningInputV1(challenge), signing.secretKey))) };
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const staleEvidence = [{ kind: "home_method" as const, methodId: "email_password" }];
        const team = await db.team.create({ data: {
            name: "Removed password evidence",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            },
        } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: account.id,
            role: "owner",
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        registerAuthEntryRoute(app, { isEmailDeliveryReady: () => true });
        await app.ready();
        try {
            const teamEntry = () => app.inject({
                method: "POST",
                url: "/v1/auth/entry",
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, scope: { kind: "team", teamId: team.id } },
            });
            const entryBeforeRemoval = await teamEntry();
            expect(entryBeforeRemoval.statusCode, entryBeforeRemoval.body).toBe(200);
            expect(entryBeforeRemoval.json()).toMatchObject({ state: "already_member" });
            const remove = (expectedCredentialRevision: number) => app.inject({ method: "POST", url: "/v1/account/password/remove",
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, kind: "e2ee", expectedCredentialRevision, proof } });
            expect((await remove(2)).statusCode).toBe(409);
            expect(await db.keyChallengeV2.findUniqueOrThrow({ where: { id: challenge.challengeId } })).toMatchObject({ consumedAt: null });
            await db.homeGovernancePolicy.upsert({
                where: { id: HOME_GOVERNANCE_POLICY_ID },
                create: {
                    id: HOME_GOVERNANCE_POLICY_ID,
                    authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
                },
                update: {
                    authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
                },
            });
            const stranded = await remove(1);
            expect(stranded.statusCode, stranded.body).toBe(409);
            expect(stranded.json()).toEqual({ error: "last_login_method" });
            expect(await db.keyChallengeV2.findUniqueOrThrow({ where: { id: challenge.challengeId } })).toMatchObject({ consumedAt: null });
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(1);
            await db.homeGovernancePolicy.update({
                where: { id: HOME_GOVERNANCE_POLICY_ID },
                // Password stays available for the Home and other Accounts;
                // this Account can still recover through its retained key.
                data: { authenticationPolicy: { v: 1, enabledMethodIds: ["email_password", "key_challenge"] } },
            });
            const removed = await remove(1);
            expect(removed.statusCode, removed.body).toBe(200);
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(0);
            expect(await db.accountEmail.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ publicKey, encryptionMode: "e2ee" });
            expect(await auth.verifyToken(token)).not.toBeNull();
            const entryAfterRemoval = await teamEntry();
            expect(entryAfterRemoval.statusCode, entryAfterRemoval.body).toBe(200);
            expect(entryAfterRemoval.json()).toMatchObject({
                state: "admission_required",
                actions: expect.arrayContaining([
                    expect.objectContaining({ methodId: "email_password", origin: "home" }),
                ]),
            });
            expect(await db.teamMembership.findUniqueOrThrow({
                where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
            })).toEqual(membership);

            const apiTokenCountBefore = await db.accountApiToken.count({ where: { accountId: account.id } });
            await expect(auth.createApiToken({
                accountId: account.id,
                tokenId: crypto.randomUUID(),
                label: "Must not inherit removed password",
                authenticationEvidence: staleEvidence,
            })).rejects.toMatchObject({ code: "credential_authentication_evidence_unavailable" });
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(apiTokenCountBefore);

            await expect(inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: account.id,
                teamId: team.id,
                externalSharingPolicy: "disabled",
                authentication: {
                    authenticationAuthority: "present_user",
                    authenticationEvidence: staleEvidence,
                },
            }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });
            expect(await db.team.findUniqueOrThrow({ where: { id: team.id } }))
                .toMatchObject({ externalSharingPolicy: "allowed" });
        } finally {
            await db.homeGovernancePolicy.deleteMany({ where: { id: HOME_GOVERNANCE_POLICY_ID } });
            await app.close();
        }
    });

    it("maps an E2EE credential binding mismatch during removal to the canonical inconsistency error", async () => {
        const accountSigning = tweetnacl.sign.keyPair();
        const credentialSigning = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(new Uint8Array(accountSigning.publicKey)),
        } });
        const email = "mismatched-removal@example.test";
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: email,
            profile: {},
        } });
        const field = (length: number) => encodePasswordCredentialFieldV1(new Uint8Array(length));
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: {
            v: 1,
            kind: "e2ee_password_envelope",
            authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32)) },
            envelope: {
                v: 1,
                accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(credentialSigning.publicKey)),
                kdf: { algorithm: "argon2id13", salt: field(16), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: field(12), ciphertext: field(48) },
            },
        } } });
        const challenge = await issuePasswordMutationKeyChallengeV1({ env: process.env, mutation: {
            v: 1,
            action: "remove",
            accountId: account.id,
            expectedCredentialRevision: 1,
            normalizedNativeEmail: email,
            newCredentialDigest: null,
        } });
        if (!challenge) throw new Error("challenge unavailable");
        const proof = {
            challengeId: challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(accountSigning.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(challenge),
                accountSigning.secretKey,
            ))),
        };
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
        });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/password/remove",
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, kind: "e2ee", expectedCredentialRevision: 1, proof },
            });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toEqual({ error: "credential_inconsistent" });
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: "email" } })).toBe(1);
            expect(await db.keyChallengeV2.findUniqueOrThrow({ where: { id: challenge.challengeId } }))
                .toMatchObject({ consumedAt: null });
        } finally {
            await app.close();
        }
    });

    it.each([false, true])("changes only the bound Account sign-in email (identity replaced: %s)", async (replaceIdentity) => {
        const previousEmail = `previous-${replaceIdentity}@example.test`;
        const replacementEmail = `replacement-${replaceIdentity}@example.test`;
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const identity = await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: previousEmail, profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode("current long password value")) } } });
        const issued = await inTx(tx => issueNativeAuthOneTimeOperationInTx(tx, {
            v: 1, purpose: "verify_native_email", normalizedEmail: replacementEmail,
            consumer: { kind: "sign_in_email_change", accountId: account.id, nativeIdentityId: identity.id, expectedNativeIdentity: previousEmail },
        }));
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const submit = () => app.inject({ method: "POST", url: "/v1/account/email/change",
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, verificationToken: issued.rawBearer } });
            const collisionAccount = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
            const collisionIdentity = await db.accountIdentity.create({ data: {
                accountId: collisionAccount.id,
                provider: "email",
                providerUserId: replacementEmail,
                profile: {},
            } });
            expect((await submit()).statusCode).toBe(409);
            expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: issued.rawBearer }))).not.toBeNull();
            await db.accountIdentity.delete({ where: { id: collisionIdentity.id } });
            await db.accountIdentity.update({ where: { accountId_provider: { accountId: account.id, provider: "email" } }, data: { providerUserId: "intervening@example.test" } });
            expect((await submit()).statusCode).toBe(409);
            expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: issued.rawBearer }))).not.toBeNull();
            await db.accountIdentity.update({ where: { accountId_provider: { accountId: account.id, provider: "email" } }, data: { providerUserId: previousEmail } });
            if (replaceIdentity) {
                await db.accountIdentity.delete({ where: { accountId_provider: { accountId: account.id, provider: "email" } } });
                await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: previousEmail, profile: {} } });
                const stale = await submit();
                expect(stale.statusCode, stale.body).toBe(409);
                expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: issued.rawBearer }))).not.toBeNull();
                expect(await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: account.id, provider: "email" } } })).toMatchObject({ providerUserId: previousEmail });
                return;
            }
            const changed = await submit();
            expect(changed.statusCode, changed.body).toBe(200);
            expect(await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: account.id, provider: "email" } } })).toMatchObject({ providerUserId: replacementEmail });
            expect(await db.accountEmail.findUnique({ where: { accountId_normalizedEmail: { accountId: account.id, normalizedEmail: replacementEmail } } })).not.toBeNull();
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } })).toMatchObject({ revision: 1 });
            expect(await inTx(tx => readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: issued.rawBearer }))).toBeNull();
            expect((await submit()).statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it("projects safe facts and changes the password with current proof and revision fencing while preserving sessions", async () => {
        const password = "current password with spaces";
        const replacement = "replacement password with spaces";
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: "security@example.test", profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode(password)) } } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        const headers = { authorization: `Bearer ${token}` };
        try {
            const read = await app.inject({ method: "GET", url: "/v1/account/security", headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ v: 1, encryptionMode: "plain", nativeEmail: "security@example.test",
                password: { status: "enrolled", revision: 1 } });
            expect(read.body).not.toMatch(/plain_password_hash|salt|digest|envelope|authVerifier/);
            const change = (currentPassword: string, revision = 1) => app.inject({ method: "POST", url: "/v1/account/password/change", headers,
                payload: { v: 1, kind: "plain", expectedCredentialRevision: revision, currentPassword, newPassword: replacement } });
            expect((await change("incorrect password value")).statusCode).toBe(401);
            const rejected = await app.inject({ method: "POST", url: "/v1/account/password/change", headers,
                payload: { v: 1, kind: "plain", expectedCredentialRevision: 1, currentPassword: password, newPassword: "too short" } });
            expect(rejected.statusCode).toBe(400);
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } })).toMatchObject({ revision: 1 });
            const raced = await Promise.all([change(password), change(password)]);
            expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409]);
            expect(raced.find((response) => response.statusCode === 200)?.json()).toEqual({ v: 1, status: "updated" });
            expect(await auth.verifyToken(token)).not.toBeNull();
            const stored = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(stored.revision).toBe(2);
            const credential = parseAccountPasswordCredentialV1("plain", stored.credential);
            if (!credential.ok || credential.mode !== "plain") throw new Error("invalid credential");
            expect(await verifyPasswordMaterial(credential.credential.hash, new TextEncoder().encode(replacement))).toBe(true);
            const remove = await app.inject({ method: "POST", url: "/v1/account/password/remove", headers,
                payload: { v: 1, kind: "plain", expectedCredentialRevision: 2, currentPassword: replacement } });
            expect(remove.statusCode, remove.body).toBe(409);
            expect(remove.json()).toEqual({ error: "last_login_method" });
            expect(await db.accountPasswordCredential.count({ where: { accountId: account.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it("admits a current Account API token only to the safe Account-scoped projection", async () => {
        const password = "automation-visible credential must stay secret";
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: "automation-security@example.test",
            profile: {},
        } });
        await db.accountEmail.create({ data: {
            accountId: account.id,
            normalizedEmail: "automation-security@example.test",
            address: "automation-security@example.test",
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: account.id,
            credential: {
                v: 1,
                kind: "plain_password_hash",
                hash: await hashPasswordMaterial(new TextEncoder().encode(password)),
            },
        } });
        const otherAccount = await db.account.create({ data: { encryptionMode: "e2ee", publicKey: "other-account-key" } });
        await db.accountIdentity.create({ data: {
            accountId: otherAccount.id,
            provider: "email",
            providerUserId: "other-security@example.test",
            profile: {},
        } });

        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "Account Security read" });
        const expiredPat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Expired Account Security read",
            expiresAt: new Date("2000-01-02T00:00:00.000Z"),
        }, new Date("2000-01-01T00:00:00.000Z"));
        const otherPat = await auth.createApiToken({ accountId: otherAccount.id, tokenId: crypto.randomUUID(), label: "Other Account Security read" });

        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();

        const read = (token: string) => app.inject({
            method: "GET",
            url: "/v1/account/security",
            headers: { authorization: `Bearer ${token}` },
        });

        try {
            const response = await read(pat.token);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                v: 1,
                encryptionMode: "plain",
                nativeEmail: "automation-security@example.test",
                password: { status: "enrolled", revision: 1 },
                terminalPresentUserPolicy: "allowed",
            });
            expect(response.body).not.toMatch(/plain_password_hash|hash|salt|digest|envelope|authVerifier|authenticationEvidence|repeatKey|operation/i);

            const otherResponse = await read(otherPat.token);
            expect(otherResponse.statusCode, otherResponse.body).toBe(200);
            expect(otherResponse.json()).toEqual({
                v: 1,
                encryptionMode: "e2ee",
                nativeEmail: "other-security@example.test",
                password: { status: "not_enrolled", revision: null },
                terminalPresentUserPolicy: "allowed",
            });
            expect(otherResponse.body).not.toContain("automation-security@example.test");

            expect((await read(expiredPat.token)).statusCode).toBe(401);
            expect((await read(pat.token.replace(pat.tokenId, "550e8400-e29b-41d4-a716-446655440000"))).statusCode).toBe(401);

            const beforeCredential = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } });
            const beforeOperations = await db.repeatKey.count();
            const mutationRequests = [
                app.inject({
                    method: "POST",
                    url: "/v1/account/password/enroll",
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: {
                        v: 1,
                        kind: "plain",
                        email: "automation-enrollment@example.test",
                        password: "automation must not enroll this password",
                        reauthentication: {
                            requestDigest: "A".repeat(43),
                            externalAuthProof: { provider: "mtls", pending: "pending-proof", proof: "proof" },
                        },
                    },
                }),
                app.inject({
                    method: "POST",
                    url: "/v1/account/password/change",
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: {
                        v: 1,
                        kind: "plain",
                        expectedCredentialRevision: 1,
                        currentPassword: password,
                        newPassword: "replacement automation must not install",
                    },
                }),
                app.inject({
                    method: "POST",
                    url: "/v1/account/password/remove",
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: { v: 1, kind: "plain", expectedCredentialRevision: 1, currentPassword: password },
                }),
                app.inject({
                    method: "POST",
                    url: "/v1/account/email/change/request",
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: { v: 1, email: "automation-replacement@example.test" },
                }),
            ];
            const mutationResponses = await Promise.all(mutationRequests);
            expect(mutationResponses.map((candidate) => candidate.statusCode)).toEqual([403, 403, 403, 403]);
            expect(mutationResponses.map((candidate) => candidate.json())).toEqual([
                { error: "present_user_required" },
                { error: "present_user_required" },
                { error: "present_user_required" },
                { error: "present_user_required" },
            ]);
            await expect(db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } })).resolves.toEqual(beforeCredential);
            await expect(db.repeatKey.count()).resolves.toBe(beforeOperations);

            await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId });
            expect((await read(pat.token)).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("fails the Account Security projection closed when the persisted mode and password credential disagree", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: "mismatch@example.test", profile: {},
        } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: {
            v: 1, kind: "e2ee_password_envelope",
            envelope: {
                v: 1,
                accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(32)),
                kdf: { algorithm: "argon2id13", salt: encodePasswordCredentialFieldV1(new Uint8Array(16)), opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: encodePasswordCredentialFieldV1(new Uint8Array(12)), ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48)) },
            },
            authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32)) },
        } } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        try {
            const response = await app.inject({ method: "GET", url: "/v1/account/security",
                headers: { authorization: `Bearer ${token}` } });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toEqual({ error: "credential_inconsistent" });
            expect(response.body).not.toMatch(/envelope|authVerifier|digest|salt/);
        } finally { await app.close(); }
    });

    it("reports authenticated sign-in-email delivery failure through the composed mail boundary", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "email",
            providerUserId: "delivery-current@example.test",
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode("delivery current password")) } } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app, {
            isEmailDeliveryReady: () => true,
            authEmailDelivery: { isReady: async () => true, deliver: async () => ({ status: "failed", reason: "transport_failed", detail: "offline" }) },
            resolveApplicationLinkTarget: async () => ({
                applicationOrigin: "https://app.example.test",
                homeTarget: "portable-home-target",
                serverId: "home",
            }),
        });
        await app.ready();
        try {
            const before = await db.repeatKey.count();
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/email/change/request",
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, email: "delivery-replacement@example.test" },
            });
            expect(response.statusCode, response.body).toBe(503);
            expect(response.json()).toEqual({ error: "email_delivery_unavailable" });
            expect(await db.repeatKey.count()).toBeGreaterThan(before);
        } finally { await app.close(); }
    });
});

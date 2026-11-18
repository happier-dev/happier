import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
    PasswordMutationPreparationResponseV1Schema,
    createPasswordMutationChallengeSigningInputV1,
    encodePasswordCredentialFieldV1,
    type PasswordMutationChallengeV1,
    type PasswordWrappedRecoverySecretV1,
} from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { prepareE2eeAccountPasswordChange, submitAccountPasswordChange } from "../../../../../../ui/sources/sync/api/auth/accountSecurity";

// Use the UI's Node adapters at genuine platform boundaries; client request
// preparation, password envelopes, signing and canonical binding remain real.
vi.mock("../../../../../../ui/sources/platform/cryptoRandom", async () =>
    await import("../../../../../../ui/sources/platform/cryptoRandom.node"));
vi.mock("../../../../../../ui/sources/platform/digest", async () =>
    await import("../../../../../../ui/sources/platform/digest.node"));

describe("Account Security real client proof → registered HTTP consumer", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "account-security-client-proof-", initAuth: true,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true", AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_SERVER_IDENTITY_ID: "srv_security_home" } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each(["change", "recover"] as const)("accepts the real client %s proof, refuses substitution and replay, and preserves Account keys", async (action) => {
        // Both public keys contain URL-safe alphabet characters, so this test
        // cannot accidentally pass the incompatible standard-base64 decoder.
        const secret = new Uint8Array(32).fill(action === "change" ? 18 : 19);
        const signing = tweetnacl.sign.keyPair.fromSeed(secret);
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee", publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        } });
        const email = `${action}@example.test`;
        await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: email, profile: {} } });
        const field = (length: number, fill: number) => encodePasswordCredentialFieldV1(new Uint8Array(length).fill(fill));
        const envelope: PasswordWrappedRecoverySecretV1 = {
            v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
            kdf: { algorithm: "argon2id13", salt: field(16, 1), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
            cipher: { algorithm: "aes256gcm", nonce: field(12, 2), ciphertext: field(48, 3) },
        };
        const initialCredential = { v: 1 as const, kind: "e2ee_password_envelope" as const, envelope,
            authVerifier: { v: 1 as const, hash: await hashPasswordMaterial(new Uint8Array(32).fill(4)) } };
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: initialCredential } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        // Exercise the production auth-method registration, challenge route, schema,
        // transaction and consumer. Only the HTTP carrier is in-process.
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        let issuedChallenge: PasswordMutationChallengeV1 | null = null;
        const request = async (path: string, init?: RequestInit) => {
            const response = await app.inject({ method: "POST", url: path,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                payload: String(init?.body ?? "") });
            if (path === ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1 && response.statusCode === 200) {
                const preparation = PasswordMutationPreparationResponseV1Schema.parse(response.json());
                if ("challenge" in preparation) issuedChallenge = preparation.challenge ?? null;
            }
            return new Response(response.body, { status: response.statusCode });
        };
        try {
            const prepared = await prepareE2eeAccountPasswordChange(request, {
                action, accountId: account.id, expectedCredentialRevision: 1, normalizedNativeEmail: email,
                secret, expectedAudience: { origin: "https://home.example.test", serverIdentityId: "srv_security_home" },
                newPassword: "correct horse battery staple",
                // KDF execution is covered by its real cryptographic owner suite;
                // this seam begins with its canonical prepared envelope/authKey.
                preparedCredentialMaterial: { envelope, authKey: field(32, 8) },
            });
            const mutation = async (body: unknown) => app.inject({ method: "POST", url: "/v1/account/password/change",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
            const substituted = await mutation({ ...prepared, action: action === "change" ? "recover" : "change" });
            expect(substituted.statusCode).toBe(403);
            const nonCanonical = await mutation({ ...prepared, proof: { ...prepared.proof, signature: `${prepared.proof.signature}=` } });
            expect(nonCanonical.statusCode).toBe(403);
            if (!issuedChallenge) throw new Error("mutation_challenge_not_issued");
            // Even a correctly signed proof made with the authentication key
            // alone cannot replace the Account recovery/signing authority.
            const authenticationOnly = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
            const authenticationOnlyProof = {
                challengeId: prepared.proof.challengeId,
                publicKey: encodePasswordCredentialFieldV1(authenticationOnly.publicKey),
                signature: encodePasswordCredentialFieldV1(tweetnacl.sign.detached(
                    createPasswordMutationChallengeSigningInputV1(issuedChallenge), authenticationOnly.secretKey,
                )),
            };
            authenticationOnly.secretKey.fill(0);
            const authKeyOnly = await mutation({ ...prepared, proof: authenticationOnlyProof });
            expect(authKeyOnly.statusCode).toBe(403);
            expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.proof.challengeId } })).toMatchObject({ consumedAt: null });
            // A typed failure never interpolates the credential-bearing request.
            let failure: { status?: number; code?: string } | null = null;
            try { await submitAccountPasswordChange(request, prepared); } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || !("status" in error)) throw error;
                failure = { code: typeof error.code === "string" ? error.code : undefined,
                    status: typeof error.status === "number" ? error.status : undefined };
            }
            expect(failure).toBeNull();
            const stored = await db.accountPasswordCredential.findUnique({ where: { accountId: account.id } });
            expect(stored?.revision).toBe(2);
            expect(JSON.stringify(stored?.credential) === JSON.stringify(prepared.targetCredential)).toBe(true);
            const currentAccount = await db.account.findUnique({ where: { id: account.id } });
            expect(currentAccount?.publicKey === account.publicKey).toBe(true);
            expect(currentAccount?.encryptionMode).toBe("e2ee");
            expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.proof.challengeId } })).toMatchObject({ consumedAt: expect.any(Date) });
            const replay = await mutation(prepared);
            expect(replay.statusCode).toBe(409);
        } finally { secret.fill(0); signing.secretKey.fill(0); await app.close(); }
    });
});

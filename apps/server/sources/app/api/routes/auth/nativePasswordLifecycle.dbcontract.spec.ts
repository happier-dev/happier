import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import {
    createNativeAuthOneTimeOperationKeyV1,
    createPasswordCredentialTargetDigestV1,
    createPasswordMutationChallengeSigningInputV1,
    encodePasswordCredentialFieldV1,
    normalizeVerifiedEmail,
    createKeyChallengeV2SigningInput,
    KeyChallengeV2IssueResponseSchema,
    signAccountContentKeyBindingV1,
    type AccountPasswordCredentialV1,
    type E2eeAccountPasswordCredentialV1,
    type PasswordCredentialMutationV1,
} from "@happier-dev/protocol";
import {
    consumePasswordMutationKeyChallengeInTx,
    decodeVerifiedNativePasswordEvidenceV1,
    issuePasswordMutationKeyChallengeV1,
} from "@/app/auth/keyChallengeV2";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { auth } from "@/app/auth/auth";
import { issueNativeAuthOneTimeOperationInTx } from "@/app/auth/email/nativeAuthOneTimeOperations";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { createTeamInvitationForActorInTx } from "@/app/teams/invitations/invitationService";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { registerAccountSecurityRoutes } from "./registerAccountSecurityRoutes";
import { registerKeyChallengeAuthRoute } from "./registerKeyChallengeAuthRoute";
import { db, initDbMysql, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createEnvPatcher } from "@/testkit/env";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";

type NativeContractProvider = "postgres" | "mysql";

function resolveProvider(): NativeContractProvider {
    const raw = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported native-auth contract provider: ${raw}. Expected postgres or mysql.`);
}

function resolveDatabaseUrl(provider: NativeContractProvider): string | null {
    const providerUrl = provider === "postgres"
        ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
    return providerUrl?.trim() || null;
}

function fullLengthEmail(firstCharacter: "a" | "z", runKey: string): string {
    const local = `${firstCharacter}${runKey}${"x".repeat(63 - runKey.length)}`;
    return `${local}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}`;
}

function createApp(): FastifyInstance {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerKeyChallengeAuthRoute(app);
    const delivery: AuthEmailDelivery = {
        isReady: async () => true,
        deliver: async () => ({ status: "sent" }),
    };
    emailPasswordAuthMethodModule.registerRoutes(app, {
        authEmailDelivery: delivery,
        isEmailDeliveryReady: () => true,
        resolveApplicationLinkTarget: async () => ({
            applicationOrigin: "https://app.example.test",
            homeTarget: "provider-db-contract-home",
            serverId: "provider-db-contract-home",
        }),
    });
    return app;
}

async function issueFreshAccountProof(normalizedEmail: string) {
    return await inTx((tx) => issueNativeAuthOneTimeOperationInTx(tx, {
        v: 1,
        purpose: "verify_native_email",
        normalizedEmail,
        consumer: { kind: "fresh_account", continuationId: null },
    }));
}

async function installTargetedMembershipFailureTrigger(
    provider: NativeContractProvider,
    teamId: string,
    suffix: string,
): Promise<() => Promise<void>> {
    if (!/^[a-z0-9-]+$/iu.test(teamId) || !/^[a-z0-9]+$/iu.test(suffix)) {
        throw new Error("Unsafe provider-contract trigger identifier");
    }
    const triggerName = `native_auth_member_${suffix}`;
    if (provider === "mysql") {
        await db.$executeRawUnsafe(`CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON \`TeamMembership\` FOR EACH ROW BEGIN IF NEW.\`teamId\` = '${teamId}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'native auth membership fault'; END IF; END`);
        return async () => {
            await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
        };
    }
    const functionName = `${triggerName}_fn`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."teamId" = '${teamId}' THEN RAISE EXCEPTION 'native auth membership fault'; END IF; RETURN NEW; END; $$`);
    try {
        await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "TeamMembership" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    } catch (error) {
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
        throw error;
    }
    return async () => {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "TeamMembership"`);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    };
}

describe("native password public-owner provider contract", () => {
    const provider = resolveProvider();
    const databaseUrl = resolveDatabaseUrl(provider);
    const providerIt = databaseUrl ? it : it.skip;
    const createdAccountIds = new Set<string>();
    const createdTeamIds = new Set<string>();
    const issuedProofKeys = new Set<string>();
    let connected = false;
    const env = createEnvPatcher(["HANDY_MASTER_SECRET", "HAPPIER_DB_TX_MAX_RETRIES"]);

    beforeAll(async () => {
        if (!databaseUrl) return;
        process.env.DATABASE_URL = databaseUrl;
        process.env.HAPPIER_DB_PROVIDER = provider;
        process.env.HAPPY_DB_PROVIDER = provider;
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "true";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED = "true";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "";
        process.env.HAPPIER_PUBLIC_SERVER_URL = "https://home.example.test";
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_native-auth-${provider}-contract`;
        env.set("HANDY_MASTER_SECRET", process.env.HANDY_MASTER_SECRET ?? "native-password-lifecycle-db-contract");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
        await auth.init();
    }, 120_000);

    afterEach(async () => {
        if (!connected) return;
        if (createdTeamIds.size > 0) {
            await db.team.deleteMany({ where: { id: { in: [...createdTeamIds] } } });
            createdTeamIds.clear();
        }
        if (createdAccountIds.size > 0) {
            await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
            createdAccountIds.clear();
        }
        if (issuedProofKeys.size > 0) {
            await db.repeatKey.deleteMany({ where: { key: { in: [...issuedProofKeys] } } });
            issuedProofKeys.clear();
        }
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
        env.restore();
    });

    providerIt("provisions, logs in, changes a full-length sign-in address, and preserves normalization uniqueness", async () => {
        const runKey = randomUUID().replace(/-/gu, "").slice(0, 16);
        const originalEmail = fullLengthEmail("a", runKey);
        const changedEmail = fullLengthEmail("z", runKey);
        expect(originalEmail).toHaveLength(320);
        expect(changedEmail).toHaveLength(320);
        expect(normalizeVerifiedEmail(originalEmail)?.normalizedEmail).toBe(originalEmail);
        const password = `provider-contract password ${runKey}`;
        const proof = await issueFreshAccountProof(originalEmail);
        issuedProofKeys.add(createNativeAuthOneTimeOperationKeyV1("verify_native_email", proof.rawBearer));
        const app = createApp();
        await app.ready();
        try {
            const provisioned = await app.inject({
                method: "POST",
                url: "/v1/auth/email/provision",
                payload: {
                    v: 1,
                    email: originalEmail,
                    admission: { kind: "native_email_verification", token: proof.rawBearer },
                    account: { mode: "plain", password },
                },
            });
            expect(provisioned.statusCode, provisioned.body).toBe(200);
            const provisionedBody = provisioned.json<{ accountId: string; token: string }>();
            createdAccountIds.add(provisionedBody.accountId);

            const initialLogin = await app.inject({
                method: "POST",
                url: "/v1/auth/email/login",
                payload: { v: 1, email: originalEmail, password },
            });
            expect(initialLogin.statusCode, initialLogin.body).toBe(200);

            const changeProof = await inTx(async (tx) => issueNativeAuthOneTimeOperationInTx(tx, {
                v: 1,
                purpose: "verify_native_email",
                normalizedEmail: changedEmail,
                consumer: {
                    kind: "sign_in_email_change",
                    accountId: provisionedBody.accountId,
                    nativeIdentityId: (await tx.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: provisionedBody.accountId, provider: "email" } } })).id,
                    expectedNativeIdentity: originalEmail,
                },
            }));
            issuedProofKeys.add(createNativeAuthOneTimeOperationKeyV1("verify_native_email", changeProof.rawBearer));
            const changed = await app.inject({
                method: "POST",
                url: "/v1/account/email/change",
                headers: { authorization: `Bearer ${provisionedBody.token}` },
                payload: { v: 1, verificationToken: changeProof.rawBearer },
            });
            expect(changed.statusCode, changed.body).toBe(200);

            const changedLogin = await app.inject({
                method: "POST",
                url: "/v1/auth/email/login",
                payload: { v: 1, email: changedEmail, password },
            });
            expect(changedLogin.statusCode, changedLogin.body).toBe(200);
            expect((await app.inject({
                method: "POST",
                url: "/v1/auth/email/login",
                payload: { v: 1, email: originalEmail, password },
            })).statusCode).toBe(401);

            const collisionProof = await issueFreshAccountProof(changedEmail);
            issuedProofKeys.add(createNativeAuthOneTimeOperationKeyV1("verify_native_email", collisionProof.rawBearer));
            const collision = await app.inject({
                method: "POST",
                url: "/v1/auth/email/provision",
                payload: {
                    v: 1,
                    email: changedEmail.toUpperCase(),
                    admission: { kind: "native_email_verification", token: collisionProof.rawBearer },
                    account: { mode: "plain", password: `${password} collision` },
                },
            });
            expect(collision.statusCode, collision.body).toBe(401);
            expect(await db.accountIdentity.count({
                where: { provider: "email", providerUserId: changedEmail },
            })).toBe(1);
            expect(await db.account.count({
                where: { AccountIdentity: { some: { provider: "email", providerUserId: changedEmail } } },
            })).toBe(1);
            expect(await db.repeatKey.findUnique({
                where: { key: createNativeAuthOneTimeOperationKeyV1("verify_native_email", collisionProof.rawBearer) },
            })).not.toBeNull();
            const directoryEnv = createEnvPatcher(["HAPPIER_AUTH_SIGN_IN_SERVICE_MODE", "HAPPIER_CANONICAL_SERVER_URL"]);
            directoryEnv.setMany({ HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "self", HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test" });
            try {
                const directoryLogin = await app.inject({ method: "POST", url: "/v1/auth/email/login",
                    payload: { v: 1, email: changedEmail, password, credentialTarget: "account_directory" } });
                expect(directoryLogin.statusCode, directoryLogin.body).toBe(200);
                expect(await auth.verifyToken(directoryLogin.json<{ token: string }>().token))
                    .toMatchObject({ userId: provisionedBody.accountId, authTokenKind: "account_directory" });
                expect(await db.accountHomeDirectoryEntry.findUnique({ where: { accountId_homeServerIdentityId: {
                    accountId: provisionedBody.accountId, homeServerIdentityId: process.env.HAPPIER_SERVER_IDENTITY_ID!,
                } } })).not.toBeNull();
            } finally { directoryEnv.restore(); }
        } finally {
            await app.close();
        }
    }, 120_000);

    providerIt("claims exactly one of two simultaneous password-mutation proofs over one credential revision", async () => {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            encryptionMode: "e2ee",
        } });
        createdAccountIds.add(account.id);
        const mutation: PasswordCredentialMutationV1 = {
            v: 1,
            action: "change",
            accountId: account.id,
            expectedCredentialRevision: 1,
            normalizedNativeEmail: `${randomUUID().replace(/-/gu, "")}@race.example.test`,
            newCredentialDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        };
        const challenge = await issuePasswordMutationKeyChallengeV1({ mutation, env: process.env });
        if (!challenge) throw new Error("challenge issuance unavailable");
        const proof = {
            challengeId: challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(challenge), signing.secretKey,
            ))),
        };
        const consume = () => inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
            return consumePasswordMutationKeyChallengeInTx(tx, { mutation, proof, env: process.env });
        });

        // The same valid proof is presented twice at once on this provider's
        // real isolation level. The claim is once-only: one commits, the other
        // is refused or aborts, and the challenge cannot be replayed after.
        const outcomes = await Promise.allSettled([consume(), consume()]);
        const claims = outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : "rejected");
        expect(claims.filter((claim) => claim === true)).toHaveLength(1);
        expect(await db.keyChallengeV2.findUnique({ where: { id: challenge.challengeId } }))
            .toMatchObject({ consumedAt: expect.any(Date) });
        expect(await consume()).toBe(false);
    }, 120_000);

    (provider === "postgres" ? providerIt : it.skip).each(["password", "email", "directory-login", "first-key-step-up", "unlock"] as const)("completes %s after a concurrent Account cursor advance without consuming conflict retries", async change => {
        const password = `initial password ${randomUUID()}`;
        const newPassword = `replacement password ${randomUUID()}`;
        const signing = change === "unlock" ? tweetnacl.sign.keyPair() : null;
        if (signing) await getOrCreateServerIdentityId(process.env);
        const account = await db.account.create({ data: { encryptionMode: signing ? "e2ee" : "plain",
            ...(signing ? { publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)) } : {}) } });
        createdAccountIds.add(account.id);
        const identity = await db.accountIdentity.create({ data: { accountId: account.id, provider: "email",
            providerUserId: `${randomUUID()}@password-contention.example.test`, profile: {} } });
        const authKey = new Uint8Array(32).fill(7);
        const field = (length: number) => encodePasswordCredentialFieldV1(new Uint8Array(length).fill(7));
        const credential: AccountPasswordCredentialV1 = signing ? {
            v: 1, kind: "e2ee_password_envelope", authVerifier: { v: 1, hash: await hashPasswordMaterial(authKey) },
            envelope: { v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
                kdf: { algorithm: "argon2id13", salt: field(16), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: field(12), ciphertext: field(48) } },
        } : { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode(password)) };
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const changedEmail = `${randomUUID()}@changed-contention.example.test`;
        const verification = change === "email" ? await inTx(tx => issueNativeAuthOneTimeOperationInTx(tx, {
            v: 1, purpose: "verify_native_email", normalizedEmail: changedEmail,
            consumer: { kind: "sign_in_email_change", accountId: account.id,
                nativeIdentityId: identity.id, expectedNativeIdentity: identity.providerUserId },
        })) : null;
        if (verification) issuedProofKeys.add(createNativeAuthOneTimeOperationKeyV1("verify_native_email", verification.rawBearer));
        const directoryEnv = createEnvPatcher(["HAPPIER_AUTH_SIGN_IN_SERVICE_MODE", "HAPPIER_CANONICAL_SERVER_URL"]);
        if (change === "directory-login") directoryEnv.setMany({
            HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "self", HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
        });
        const app = createApp();
        await app.ready();
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>(resolve => { locked = resolve; });
        const released = new Promise<void>(resolve => { release = resolve; });
        let peerPid = 0;
        let issuedChallengeId: string | undefined;
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        env.set("HAPPIER_DB_TX_MAX_RETRIES", "0");
        const writing = inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            peerPid = pid;
            locked();
            await released;
        });
        await held;
        const changing = app.inject({ method: "POST", url: change === "password" ? "/v1/account/password/change"
            : change === "email" ? "/v1/account/email/change" : change === "directory-login" ? "/v1/auth/email/login"
                : change === "unlock" ? "/v1/auth/email/unlock" : "/v1/auth/email/step-up",
            headers: { authorization: `Bearer ${token}` },
            payload: change === "unlock" ? { v: 1, email: identity.providerUserId, authKey: encodePasswordCredentialFieldV1(authKey) }
                : change === "first-key-step-up" ? { v: 1, password, purpose: "account_encryption_first_key", requestDigest: `aemrb1_${"A".repeat(43)}` }
                : change === "directory-login" ? { v: 1, email: identity.providerUserId, password, credentialTarget: "account_directory" }
                : verification ? { v: 1, verificationToken: verification.rawBearer }
                : { v: 1, kind: "plain", expectedCredentialRevision: 1, currentPassword: password, newPassword },
        }).then(response => response);
        try {
            await expect.poll(async () => {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${peerPid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                return blocked;
            }).toBe(true);
            release();
            await writing;
            const response = await changing;
            expect(response.statusCode, response.body).toBe(200);
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id }, select: { revision: true } }))
                .toEqual({ revision: change === "password" ? 2 : 1 });
            if (verification) {
                expect(await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: account.id, provider: "email" } } }))
                    .toMatchObject({ providerUserId: changedEmail });
                expect(await db.repeatKey.findUnique({ where: { key: createNativeAuthOneTimeOperationKeyV1("verify_native_email", verification.rawBearer) } }))
                    .toBeNull();
            }
            const currentAccount = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            if (change === "directory-login") {
                expect(currentAccount.seq).toBe(1);
                expect(await auth.verifyToken(response.json<{ token: string }>().token))
                    .toMatchObject({ userId: account.id, authTokenKind: "account_directory" });
                expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(1);
            } else if (change === "unlock") {
                expect(currentAccount.seq).toBe(1);
                const body = response.json<{ expectedAccountId: string; envelope: unknown; challenge: { challengeId: string } }>();
                issuedChallengeId = body.challenge.challengeId;
                expect(body.expectedAccountId).toBe(account.id);
                if (credential.kind !== "e2ee_password_envelope") throw new Error("Unlock fixture must be E2EE");
                expect(body.envelope).toEqual(credential.envelope);
                const challenge = await db.keyChallengeV2.findUniqueOrThrow({ where: { id: issuedChallengeId } });
                expect(decodeVerifiedNativePasswordEvidenceV1(challenge.verifiedNativeMethodId))
                    .toEqual({ nativeIdentityId: identity.id, credentialRevision: 1 });
            } else if (change === "first-key-step-up") {
                expect(currentAccount.seq).toBe(1);
                const proof = response.json<{ externalAuthProof: { pending: string } }>().externalAuthProof;
                issuedProofKeys.add(proof.pending);
                const pending = await db.repeatKey.findUniqueOrThrow({ where: { key: proof.pending } });
                expect(JSON.parse(pending.value)).toMatchObject({ userId: account.id,
                    nativeIdentityId: identity.id, credentialRevision: 1, purpose: "account_encryption_first_key" });
            } else expect(currentAccount.seq).toBeGreaterThan(1);
        } finally {
            release();
            await writing;
            await changing;
            if (issuedChallengeId) await db.keyChallengeV2.deleteMany({ where: { id: issuedChallengeId } });
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
            directoryEnv.restore();
            await app.close();
        }
    }, 120_000);

    providerIt("commits exactly one of two distinct valid password-mutation proofs over one credential revision", async () => {
        const runKey = randomUUID().replace(/-/gu, "").slice(0, 16);
        const signing = tweetnacl.sign.keyPair();
        const accountSigningPublicKey = encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey));
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            encryptionMode: "e2ee",
        } });
        createdAccountIds.add(account.id);
        const email = `${runKey}@proof-race.example.test`;
        await db.accountIdentity.create({ data: {
            accountId: account.id, provider: "email", providerUserId: email, profile: {},
        } });
        const field = (length: number, fill: number) => encodePasswordCredentialFieldV1(new Uint8Array(length).fill(fill));
        const credential = async (fill: number): Promise<E2eeAccountPasswordCredentialV1> => ({
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
        const currentCredential = await credential(1);
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: currentCredential } });

        // Two genuinely different mutations of the SAME credential revision, each
        // with its own valid signed proof. Only one may install a replacement:
        // the other must find the revision gone and leave its proof unspent.
        const attempt = async (fill: number) => {
            const targetCredential = await credential(fill);
            const mutation: PasswordCredentialMutationV1 = {
                v: 1,
                action: "change",
                accountId: account.id,
                expectedCredentialRevision: 1,
                normalizedNativeEmail: email,
                newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
            };
            const challenge = await issuePasswordMutationKeyChallengeV1({ mutation, env: process.env });
            if (!challenge) throw new Error("challenge issuance unavailable");
            return {
                targetCredential,
                challengeId: challenge.challengeId,
                payload: {
                    v: 1 as const,
                    kind: "e2ee" as const,
                    action: "change" as const,
                    expectedCredentialRevision: 1,
                    targetCredential,
                    proof: {
                        challengeId: challenge.challengeId,
                        publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
                        signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                            createPasswordMutationChallengeSigningInputV1(challenge), signing.secretKey,
                        ))),
                    },
                },
            };
        };
        const [first, second] = await Promise.all([attempt(2), attempt(3)]);
        expect(first.challengeId).not.toBe(second.challengeId);

        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountSecurityRoutes(app);
        await app.ready();
        try {
            const change = (payload: unknown) => app.inject({
                method: "POST",
                url: "/v1/account/password/change",
                headers: { authorization: `Bearer ${token}` },
                payload: payload as Record<string, unknown>,
            });
            const responses = await Promise.all([change(first.payload), change(second.payload)]);
            const statuses = responses.map((response) => response.statusCode).sort();
            expect(statuses, responses.map((response) => response.body).join(" | ")).toEqual([200, 409]);

            const stored = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(stored.revision).toBe(2);
            const winner = responses[0]?.statusCode === 200 ? first : second;
            const loser = responses[0]?.statusCode === 200 ? second : first;
            expect(stored.credential).toEqual(winner.targetCredential);
            expect(await db.keyChallengeV2.findUnique({ where: { id: winner.challengeId } }))
                .toMatchObject({ consumedAt: expect.any(Date) });
            // The loser never reached proof consumption: its challenge is still
            // spendable and the credential it proposed was never installed.
            expect(await db.keyChallengeV2.findUnique({ where: { id: loser.challengeId } }))
                .toMatchObject({ consumedAt: null });
        } finally {
            await app.close();
        }
    }, 120_000);

    providerIt("creates a fresh keyed Account and consumes its invitation with an existing Team audience", async () => {
        const inviter = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        createdAccountIds.add(inviter.id);
        const team = await db.team.create({ data: { name: `Key invitation ${randomUUID()}`, admissionMode: "invite_only" } });
        createdTeamIds.add(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: inviter.id, role: "owner" } });
        const invitation = await inTx(tx => createTeamInvitationForActorInTx(tx, {
            teamId: team.id, actorAccountId: inviter.id, role: "member", historyAccess: "from_membership",
            recipientEmailNormalized: null, emailDeliveryAvailable: false, requestKey: randomUUID(),
        }));
        if (!invitation.ok || !invitation.value.token) throw new Error("Invitation setup failed");
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const publicKey = privacyKit.encodeHex(new Uint8Array(signing.publicKey));
        const app = createApp();
        await app.ready();
        try {
            const issued = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: {} });
            expect(issued.statusCode, issued.body).toBe(200);
            const challenge = KeyChallengeV2IssueResponseSchema.parse(issued.json());
            const response = await app.inject({ method: "POST", url: "/v1/auth", payload: {
                publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
                challengeId: challenge.challengeId,
                signature: privacyKit.encodeBase64(tweetnacl.sign.detached(createKeyChallengeV2SigningInput(challenge), signing.secretKey)),
                contentPublicKey: privacyKit.encodeBase64(new Uint8Array(content.publicKey)),
                contentPublicKeySig: privacyKit.encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: new Uint8Array(signing.secretKey), contentPublicKey: new Uint8Array(content.publicKey),
                })),
                admission: { kind: "team_invitation", token: invitation.value.token },
            } });
            const account = await db.account.findUnique({ where: { publicKey } });
            if (account) createdAccountIds.add(account.id);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ success: true, token: expect.any(String) });
            expect(account).not.toBeNull();
            expect(await db.teamMembership.findUnique({ where: { teamId_accountId: { teamId: team.id, accountId: account!.id } } }))
                .toMatchObject({ role: "member", status: "active" });
            expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.value.invitation.id } }))
                .toMatchObject({ acceptedByAccountId: account!.id, acceptedAt: expect.any(Date) });
        } finally {
            await app.close();
        }
    }, 120_000);

    providerIt("rolls Account, identity, mailbox, password, and invitation consumption back when membership admission fails", async () => {
        const runKey = randomUUID().replace(/-/gu, "").slice(0, 16);
        const invitedEmail = `${runKey}@rollback.example.test`;
        const password = `rollback password ${runKey}`;
        const inviter = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        createdAccountIds.add(inviter.id);
        const team = await db.team.create({ data: { name: `Native auth rollback ${runKey}` } });
        createdTeamIds.add(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: inviter.id, role: "owner" } });
        const invitation = await inTx((tx) => createTeamInvitationForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: inviter.id,
            role: "member",
            historyAccess: "from_membership",
            recipientEmailNormalized: invitedEmail,
            emailDeliveryAvailable: true,
            requestKey: randomUUID(),
        }));
        if (!invitation.ok || !invitation.value.token) throw new Error("Invitation setup failed");
        const accountCountBeforeAdmission = await db.account.count();
        const payload = {
            v: 1,
            email: invitedEmail,
            admission: { kind: "team_invitation" as const, token: invitation.value.token },
            account: { mode: "plain" as const, password },
        };
        const removeFault = await installTargetedMembershipFailureTrigger(
            provider,
            team.id,
            randomUUID().replace(/-/gu, "").slice(0, 12),
        );
        const app = createApp();
        await app.ready();
        try {
            const failed = await app.inject({ method: "POST", url: "/v1/auth/email/provision", payload });
            expect(failed.statusCode).toBe(500);
            expect(await db.account.count()).toBe(accountCountBeforeAdmission);
            expect(await db.accountIdentity.findUnique({
                where: { provider_providerUserId: { provider: "email", providerUserId: invitedEmail } },
            })).toBeNull();
            expect(await db.accountEmail.count({ where: { normalizedEmail: invitedEmail } })).toBe(0);
            expect(await db.accountPasswordCredential.count({
                where: { account: { AccountIdentity: { some: { provider: "email", providerUserId: invitedEmail } } } },
            })).toBe(0);
            expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.value.invitation.id } }))
                .toMatchObject({ acceptedAt: null, acceptedByAccountId: null });
            expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);

            await removeFault();
            const retried = await app.inject({ method: "POST", url: "/v1/auth/email/provision", payload });
            expect(retried.statusCode, retried.body).toBe(200);
            createdAccountIds.add(retried.json<{ accountId: string }>().accountId);
            expect(await db.account.count()).toBe(accountCountBeforeAdmission + 1);
            expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(2);
        } finally {
            await removeFault().catch(() => undefined);
            await app.close();
        }
    }, 120_000);
});

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptPasswordTextV1, parseAccountPasswordCredentialV1, createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1 } from "@happier-dev/protocol";
import { createHash } from "node:crypto";
import { createMtlsClaimCode } from "@/app/auth/providers/mtls/mtlsClaimCode";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { hashPasswordMaterial, verifyPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { issueNativeAuthOneTimeOperationInTx, readNativeAuthOneTimeOperation } from "@/app/auth/email/nativeAuthOneTimeOperations";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import type { AuthMethodRouteContext } from "@/app/auth/methods/types";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe("native Plain password reset", () => {
    let harness: LightSqliteHarness;
    const original = "original password with spaces";
    const replacement = "replacement password with spaces";
    const bytes = (password: string) => {
        const accepted = acceptPasswordTextV1(password);
        if (!accepted.accepted) throw new Error("invalid fixture password");
        return accepted.utf8;
    };
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-password-reset-", initAuth: true,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true", AUTH_REQUIRED_LOGIN_PROVIDERS: "" } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("does not revive an old reset after password removal and same-email re-enrollment", async () => {
        const email = "reenrollment-reset@example.test";
        const prepared = await fixture(email);
        const changedPassword = "ordinary changed password";
        const reenrolledPassword = "new enrollment password";
        vi.stubEnv("HAPPIER_FEATURE_AUTH_MTLS__ENABLED", "true");
        vi.stubEnv("HAPPIER_FEATURE_AUTH_MTLS__MODE", "forwarded");
        vi.stubEnv("HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS", "true");
        vi.stubEnv("HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED", "true");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        try {
            await db.accountIdentity.create({ data: { accountId: prepared.account.id, provider: "mtls", providerUserId: "reset-review-mtls", profile: {} } });
            await db.accountEmail.create({ data: { accountId: prepared.account.id, normalizedEmail: email, address: email } });
            const oldIdentity = await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: prepared.account.id, provider: "email" } } });
            const issued = await prepared.issue();
            const token = await auth.createToken(prepared.account.id, undefined, { kind: "account", authority: "present_user", authenticationEvidence: [{ kind: "home_method", methodId: "mtls" }] });
            const post = (url: string, payload: Record<string, unknown>) => prepared.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
            const changed = await post("/v1/account/password/change", { v: 1, kind: "plain", expectedCredentialRevision: 1, currentPassword: original, newPassword: changedPassword });
            expect(changed.statusCode, changed.body).toBe(200);
            expect((await prepared.submit(issued.rawBearer)).statusCode).toBe(400);
            const removed = await post("/v1/account/password/remove", { v: 1, kind: "plain", expectedCredentialRevision: 2, currentPassword: changedPassword });
            expect(removed.statusCode, removed.body).toBe(200);
            const target = await post("/v1/auth/password/mutation/challenge", { v: 1, action: "connect", expectedCredentialRevision: null, normalizedNativeEmail: email, newPlainPassword: reenrolledPassword });
            expect(target.statusCode, target.body).toBe(200);
            const targetCredential = target.json().targetCredential;
            const requestDigest = createPasswordCredentialMutationDigestV1({ v: 1, action: "connect", accountId: prepared.account.id, expectedCredentialRevision: null, normalizedNativeEmail: email, newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential) });
            const proof = "fixture-password-enrollment-proof";
            const pending = await createMtlsClaimCode({ userId: prepared.account.id, ttlMs: 60_000, stepUp: { purpose: "account_password_enrollment", providerUserId: "reset-review-mtls", proofHash: createHash("sha256").update(proof).digest("hex"), requestDigest } });
            const enrolled = await post("/v1/account/password/enroll", { v: 1, kind: "plain", email, targetCredential, reauthentication: { provider: "mtls", pending, proof } });
            expect(enrolled.statusCode, enrolled.body).toBe(200);
            const newIdentity = await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: prepared.account.id, provider: "email" } } });
            expect(newIdentity.id).not.toBe(oldIdentity.id);
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: prepared.account.id } })).toMatchObject({ revision: 1 });
            const stale = await prepared.submit(issued.rawBearer);
            expect(stale.statusCode, stale.body).toBe(400);
            expect(stale.json()).toEqual({ error: "invalid_reset" });
            const current = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: prepared.account.id } });
            const parsed = parseAccountPasswordCredentialV1("plain", current.credential);
            if (!parsed.ok || parsed.mode !== "plain") throw new Error("invalid fixture credential");
            expect(await verifyPasswordMaterial(parsed.credential.hash, bytes(reenrolledPassword))).toBe(true);
            expect(await verifyPasswordMaterial(parsed.credential.hash, bytes(replacement))).toBe(false);
        } finally {
            vi.unstubAllEnvs();
            await prepared.app.close();
        }
    });

    it("returns the same accepted projection when delivery is unavailable without issuing an operation", async () => {
        const prepared = await fixture("request-reset@example.test");
        try {
            const count = await db.repeatKey.count();
            const request = (email: string) => prepared.app.inject({ method: "POST", url: "/v1/auth/password/reset/request",
                payload: { v: 1, email } });
            const known = await request("request-reset@example.test");
            expect(known.statusCode, known.body).toBe(200);
            expect(known.json()).toEqual({ accepted: true });
            expect((await request("unknown-request@example.test")).json()).toEqual(known.json());
            expect(await db.repeatKey.count()).toBe(count);
        } finally { await prepared.app.close(); }
    });

    it("projects a fresh mailbox proof as Account admission even without a separate continuation record", async () => {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const disconnectAccountSockets = vi.fn();
        app.decorate("disconnectAccountSockets", disconnectAccountSockets);
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const issued = await inTx((tx) => issueNativeAuthOneTimeOperationInTx(tx, {
                v: 1,
                purpose: "verify_native_email",
                normalizedEmail: "fresh-admission@example.test",
                consumer: { kind: "fresh_account", continuationId: null },
            }));
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/email/verify/preview",
                payload: { v: 1, token: issued.rawBearer },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ valid: true, continuation: "account_admission" });
        } finally {
            await app.close();
        }
    });

    async function fixture(email: string, routeContext?: AuthMethodRouteContext) {
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const identity = await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: email, profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(bytes(original)) } } });
        const issue = () => inTx((tx) => issueNativeAuthOneTimeOperationInTx(tx, {
            v: 1, purpose: "reset_plain_password", accountId: account.id, credentialRevision: 1, nativeIdentityId: identity.id, expectedNativeIdentity: email,
        }));
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const disconnectAccountSockets = vi.fn();
        app.decorate("disconnectAccountSockets", disconnectAccountSockets);
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app, routeContext);
        await app.ready();
        const submit = (token: string) => app.inject({ method: "POST", url: "/v1/auth/password/reset/submit",
            payload: { v: 1, token, password: replacement } });
        return { account, issue, app, submit, disconnectAccountSockets };
    }

    it("keeps reset requests neutral and creates no operation or mail when password login is disabled", async () => {
        const deliver = vi.fn(async () => ({ status: "sent" as const }));
        const prepared = await fixture("policy-disabled-request@example.test", {
            isEmailDeliveryReady: () => true,
            authEmailDelivery: { isReady: async () => true, deliver },
            resolveApplicationLinkTarget: async () => ({
                applicationOrigin: "https://app.example.test",
                homeTarget: "portable-home-target",
                serverId: "home",
            }),
        });
        try {
            await db.homeGovernancePolicy.create({
                data: {
                    id: "home",
                    authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
                },
            });
            const before = await db.repeatKey.count();
            const response = await prepared.app.inject({
                method: "POST",
                url: "/v1/auth/password/reset/request",
                payload: { v: 1, email: "policy-disabled-request@example.test" },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ accepted: true });
            expect(await db.repeatKey.count()).toBe(before);
            expect(deliver).not.toHaveBeenCalled();
        } finally {
            await db.homeGovernancePolicy.deleteMany({});
            await prepared.app.close();
        }
    });

    it("preserves the reset bearer, credential, and sessions when policy is disabled after issuance", async () => {
        const prepared = await fixture("policy-disabled-submit@example.test");
        try {
            const issued = await prepared.issue();
            const session = await auth.createToken(prepared.account.id, undefined, {
                kind: "account",
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
            });
            await db.homeGovernancePolicy.create({
                data: {
                    id: "home",
                    authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
                },
            });

            const response = await prepared.submit(issued.rawBearer);
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "method_not_available" });
            expect(await db.accountPasswordCredential.findUniqueOrThrow({
                where: { accountId: prepared.account.id },
            })).toMatchObject({ revision: 1 });
            expect(await auth.verifyToken(session)).toMatchObject({ userId: prepared.account.id });
            expect(await inTx((tx) => readNativeAuthOneTimeOperation(tx, {
                purpose: "reset_plain_password",
                token: issued.rawBearer,
            }))).not.toBeNull();
            expect(await db.accountChange.count({
                where: { accountId: prepared.account.id, kind: "account", entityId: "self" },
            })).toBe(0);
            expect(prepared.disconnectAccountSockets).not.toHaveBeenCalled();
        } finally {
            await db.homeGovernancePolicy.deleteMany({});
            await prepared.app.close();
        }
    });

    it("atomically replaces one credential, consumes its bearer and revokes sessions while preserving PATs", async () => {
        const prepared = await fixture("reset@example.test");
        try {
            const session = await auth.createToken(prepared.account.id, undefined, { kind: "account", authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
            const pat = await auth.createApiToken({ accountId: prepared.account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(prepared.account.id, "Preserved by reset") });
            const first = await prepared.issue();
            const sibling = await prepared.issue();
            const outcomes = await Promise.all([prepared.submit(first.rawBearer), prepared.submit(sibling.rawBearer)]);
            expect(outcomes.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400]);
            const response = outcomes.find(({ statusCode }) => statusCode === 200)!;
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ v: 1, status: "password_reset" });
            const credential = await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: prepared.account.id } });
            expect(credential.revision).toBe(2);
            const stored = parseAccountPasswordCredentialV1("plain", credential.credential);
            if (!stored.ok || stored.mode !== "plain") throw new Error("invalid stored credential");
            expect(await verifyPasswordMaterial(stored.credential.hash, bytes(replacement))).toBe(true);
            expect(await auth.verifyToken(session)).toBeNull();
            expect(await auth.verifyPat(pat.token)).toMatchObject({ ok: true });
            expect(await db.accountChange.count({
                where: { accountId: prepared.account.id, kind: "account", entityId: "self" },
            })).toBe(1);
            expect(prepared.disconnectAccountSockets).toHaveBeenCalledTimes(1);
            expect(prepared.disconnectAccountSockets).toHaveBeenCalledWith(prepared.account.id);
            const winningBearer = outcomes[0].statusCode === 200 ? first.rawBearer : sibling.rawBearer;
            expect(await inTx((tx) => readNativeAuthOneTimeOperation(tx, { purpose: "reset_plain_password", token: winningBearer }))).toBeNull();
            expect((await prepared.submit(first.rawBearer)).statusCode).toBe(400);
            expect((await prepared.submit(sibling.rawBearer)).statusCode).toBe(400);
            expect(await db.account.findUniqueOrThrow({ where: { id: prepared.account.id } })).toMatchObject({
                encryptionMode: "plain", publicKey: null, tokenEpoch: 1,
            });
        } finally { await prepared.app.close(); }
    });

    it("rejects a reset sent to a replaced native identity and preserves disabled Account credentials", async () => {
        const prepared = await fixture("old-reset@example.test");
        try {
            const issued = await prepared.issue();
            await db.accountIdentity.update({ where: { accountId_provider: { accountId: prepared.account.id, provider: "email" } },
                data: { providerUserId: "new-reset@example.test" } });
            expect((await prepared.submit(issued.rawBearer)).statusCode).toBe(400);
            await db.accountIdentity.update({ where: { accountId_provider: { accountId: prepared.account.id, provider: "email" } },
                data: { providerUserId: "old-reset@example.test" } });
            await db.account.update({ where: { id: prepared.account.id }, data: { status: "disabled" } });
            const response = await prepared.submit(issued.rawBearer);
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "account-disabled" });
            expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: prepared.account.id } })).toMatchObject({ revision: 1 });
            expect(await inTx((tx) => readNativeAuthOneTimeOperation(tx, {
                purpose: "reset_plain_password", token: issued.rawBearer,
            }))).not.toBeNull();
        } finally { await prepared.app.close(); }
    });

    it("keeps erased and stale reset identities neutral", async () => {
        const prepared = await fixture("neutral-reset@example.test");
        try {
            const missingAccount = await inTx((tx) => issueNativeAuthOneTimeOperationInTx(tx, {
                v: 1,
                purpose: "reset_plain_password",
                accountId: "erased-account",
                nativeIdentityId: "erased-identity",
                credentialRevision: 1,
                expectedNativeIdentity: "neutral-reset@example.test",
            }));
            expect((await prepared.submit(missingAccount.rawBearer)).statusCode).toBe(400);

            const missingCredential = await prepared.issue();
            await db.accountPasswordCredential.delete({ where: { accountId: prepared.account.id } });
            expect((await prepared.submit(missingCredential.rawBearer)).statusCode).toBe(400);
        } finally {
            await prepared.app.close();
        }
    });
});

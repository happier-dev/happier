import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { emailPasswordAuthMethodModule } from "@/app/auth/methods/modules/emailPasswordAuthMethodModule";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { consumeAccountEncryptionFirstKeyExternalAuthProofInTx } from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { plainPrivateLabel } from "@/testkit/privateLabelFixture";

describe("native current-password first-key authority", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "native-first-key-", initAuth: true,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true", AUTH_REQUIRED_LOGIN_PROVIDERS: "" } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });
    it("binds digest-only proof to current credential and consumes only with the committing transition", async () => {
        const password = "current password for first key";
        const account = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: "stepup@example.test", profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id,
            credential: { v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode(password)) } } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); emailPasswordAuthMethodModule.registerRoutes(app); await app.ready();
        const requestDigest = `aemrb1_${"A".repeat(43)}`;
        const stepUp = (candidate = password) => app.inject({ method: "POST", url: "/v1/auth/email/step-up",
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, password: candidate, purpose: "account_encryption_first_key", requestDigest } });
        try {
            const invalidBearer = await app.inject({ method: "POST", url: "/v1/auth/email/step-up",
                headers: { authorization: "Bearer invalid-token" },
                payload: { v: 1, password, purpose: "account_encryption_first_key", requestDigest } });
            expect(invalidBearer.statusCode).toBe(401);
            const wrongPassword = await stepUp("incorrect password");
            expect(wrongPassword.statusCode).toBe(403);
            expect(wrongPassword.json()).toEqual({ error: "authentication_failed" });
            expect(await auth.verifyToken(token)).toMatchObject({ userId: account.id });
            const response = await stepUp();
            expect(response.statusCode, response.body).toBe(200);
            const externalAuthProof = response.json().externalAuthProof;
            expect(externalAuthProof.provider).toBe("email_password");
            const automationToken = await auth.createToken(account.id, { session: "native-password-step-up-automation" }, { kind: "terminal", authority: "account_automation",
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] });
            expect((await app.inject({ method: "POST", url: "/v1/auth/email/step-up", headers: {
                authorization: `Bearer ${automationToken}`, [AUTHORITY_CEILING_HEADER_V1]: "account_automation",
            },
                payload: { v: 1, password, purpose: "account_encryption_first_key", requestDigest } })).statusCode).toBe(200);
            const apiToken = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(),
                label: plainPrivateLabel("Step-up scoped credential") });
            const scopedCredential = await app.inject({ method: "POST", url: "/v1/auth/email/step-up",
                headers: { authorization: `Bearer ${apiToken.token}` },
                payload: { v: 1, password, purpose: "account_encryption_first_key", requestDigest } });
            expect(scopedCredential.statusCode).toBe(403);
            expect(scopedCredential.json()).toEqual({ error: "present_user_required" });
            const persisted = await db.repeatKey.findUniqueOrThrow({ where: { key: externalAuthProof.pending } });
            expect(persisted.value).not.toContain(password);
            expect(persisted.value).not.toContain(externalAuthProof.proof);
            expect(persisted.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
            const consume = (digest = requestDigest) => inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest: digest, externalAuthProof }));
            expect(await consume(`aemrb1_${"B".repeat(43)}`)).toMatchObject({ ok: false, reason: "binding_mismatch" });
            await expect(inTx(async tx => {
                expect(await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest, externalAuthProof })).toMatchObject({ ok: true });
                throw new Error("rollback transition");
            })).rejects.toThrow("rollback transition");
            expect(await consume()).toMatchObject({ ok: true, provider: "email_password" });
            expect(await consume()).toMatchObject({ ok: false, reason: "invalid_or_consumed" });
            const stale = (await stepUp()).json().externalAuthProof;
            await db.accountPasswordCredential.update({ where: { accountId: account.id }, data: { revision: { increment: 1 } } });
            expect(await inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest, externalAuthProof: stale }))).toMatchObject({ ok: false });
            const expired = (await stepUp()).json().externalAuthProof;
            await db.repeatKey.update({ where: { key: expired.pending }, data: { expiresAt: new Date(0) } });
            expect(await inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest, externalAuthProof: expired }))).toMatchObject({ ok: false, reason: "expired" });
            const replacedEnrollment = (await stepUp()).json().externalAuthProof;
            const previousIdentity = await db.accountIdentity.findUniqueOrThrow({ where: { accountId_provider: { accountId: account.id, provider: "email" } } });
            // Replacement can preserve email and revision; neither identifies
            // the enrollment whose password was actually verified.
            await db.accountIdentity.delete({ where: { id: previousIdentity.id } });
            await db.accountIdentity.create({ data: { accountId: account.id, provider: "email", providerUserId: "stepup@example.test", profile: {} } });
            expect(await inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, {
                accountId: account.id, requestDigest, externalAuthProof: replacedEnrollment,
            }))).toMatchObject({ ok: false });
            const changedIdentity = (await stepUp()).json().externalAuthProof;
            await db.accountIdentity.updateMany({ where: { accountId: account.id, provider: "email" }, data: { providerUserId: "changed@example.test" } });
            expect(await inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest, externalAuthProof: changedIdentity }))).toMatchObject({ ok: false, reason: "identity_mismatch" });
            const changedMode = (await stepUp()).json().externalAuthProof;
            await db.account.update({ where: { id: account.id }, data: { encryptionMode: "e2ee" } });
            expect(await inTx(tx => consumeAccountEncryptionFirstKeyExternalAuthProofInTx(tx, { accountId: account.id, requestDigest, externalAuthProof: changedMode }))).toMatchObject({ ok: false });
        } finally { await app.close(); }
    });
});

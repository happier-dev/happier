import { ACCOUNT_EMAIL_CHANGE_PATH_V1, ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1, ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1, ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1, ACCOUNT_SECURITY_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1, AccountEmailChangeCompleteRequestV1Schema, AccountEmailChangeRequestV1Schema, AccountEmailChangeRequestResponseV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema, AccountPasswordEnrollEmailRequestV1Schema, AccountPasswordRemoveRequestV1Schema, AccountSecurityGetRequestV1Schema, AccountSecurityGetResponseV1Schema, AccountSecurityRouteErrorV1Schema, AccountPasswordMutationResponseV1Schema, PasswordMutationPreparationRequestV1Schema, PasswordMutationPreparationResponseV1Schema, PlainPasswordResetSubmitRequestV1Schema, PlainPasswordResetSubmitResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { createPasswordCredentialTargetDigestV1, createPasswordCredentialMutationDigestV1, type PasswordCredentialMutationV1 } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { parseAccountPasswordCredentialV1, type AccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';

import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/eventRouter";
import { consumeAccountPasswordEnrollmentExternalAuthProofInTx } from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import { auth } from "@/app/auth/auth";
import {
    requestNativeEmailVerification,
    sendAccountAuthenticationChangedNotice,
    type ResolveAuthEmailApplicationLinkTarget,
} from "@/app/auth/email/nativeAuthEmailOperations";
import { consumeNativeAuthOneTimeOperationInTx, readNativeAuthOneTimeOperation } from "@/app/auth/email/nativeAuthOneTimeOperations";
import { resolveAuthEmailReadiness } from "@/app/auth/email/resolveAuthEmailDelivery";
import { createHomeAuthEmailDelivery } from "@/app/auth/email/homeAuthEmailDelivery";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import { consumePasswordMutationKeyChallengeInTx, issuePasswordMutationKeyChallengeV1 } from "@/app/auth/keyChallengeV2";
import { checkAccountRetainsLoginRouteForDecisions, readAccountLoginViabilityFactsAfterProviderRemovalInTx } from "@/app/auth/methods/effectiveAccountLoginMethods";
import { isEffectiveHomeAuthMethodActionEnabledInTx, resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { prepareE2eeAccountPasswordCredentialV1, preparePlainAccountPasswordCredentialV1, verifyPlainAccountPasswordCredentialV1 } from "@/app/auth/password/accountPasswordCredentialPreparation";
import { isE2eePasswordCredentialBoundToAccount } from "@/app/auth/password/e2eePasswordCredentialAccountBinding";
import { PasswordHashOverloadedError } from "@/app/auth/password/passwordHashAdmission";
import { linkIdentityInTx, ProviderAlreadyLinkedError, unlinkIdentityInTx } from "@/app/auth/providers/accountIdentityLifecycle";
import { countActiveHomeOwnersInTx } from "@/app/home/governance/homeCapabilities";
import { upsertVerifiedMailboxEvidenceInTx } from "@/app/auth/verifiedMailboxEvidence";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    acquireAccountSessionOwnerMetadataFencesInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

class InvalidResetMutation extends Error {}
class CredentialMutationConflict extends Error {}
class PasswordEnrollmentReauthenticationAbort extends Error {}

type PasswordHashWorkResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

async function runPasswordHashWork<T>(work: () => Promise<T>): Promise<PasswordHashWorkResult<T>> {
    try {
        return { ok: true, value: await work() };
    } catch (error) {
        if (error instanceof PasswordHashOverloadedError) return { ok: false };
        throw error;
    }
}

const ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES = {
    400: AccountSecurityRouteErrorV1Schema,
    401: AccountSecurityRouteErrorV1Schema,
    403: AccountSecurityRouteErrorV1Schema,
    404: AccountSecurityRouteErrorV1Schema,
    409: AccountSecurityRouteErrorV1Schema,
    503: AccountSecurityRouteErrorV1Schema,
} as const;

/**
 * One Protocol owner computes these bytes so the mode-transition consumer in
 * `registerAccountEncryptionMigrateRoutes` cannot drift from this issuer.
 */
const credentialDigest = createPasswordCredentialTargetDigestV1;

function mutation(input: Readonly<{
    action: PasswordCredentialMutationV1["action"];
    accountId: string;
    revision: number | null;
    email: string | null;
    credential: AccountPasswordCredentialV1 | null;
    transitionRequestDigest?: string | null;
}>): PasswordCredentialMutationV1 {
    return {
        v: 1,
        action: input.action,
        accountId: input.accountId,
        expectedCredentialRevision: input.revision,
        normalizedNativeEmail: input.email,
        newCredentialDigest: input.credential ? credentialDigest(input.credential, input.transitionRequestDigest) : null,
    };
}

async function sendNotice(
    deps: Readonly<{ delivery: AuthEmailDelivery; resolveApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget }>,
    email: string | null,
    change: "password_connected" | "password_changed" | "password_removed" | "password_reset" | "sign_in_email_changed",
): Promise<void> {
    if (!email) return;
    const recipient = normalizeVerifiedEmail(email);
    if (!recipient) return;
    await sendAccountAuthenticationChangedNotice(deps, {
        recipient,
        change,
        occurredAt: new Date(),
    });
}

export function registerAccountSecurityRoutes(app: Fastify, params: Readonly<{
    authEmailDelivery?: AuthEmailDelivery;
    isEmailDeliveryReady?: () => boolean | Promise<boolean>;
    resolveApplicationLinkTarget?: ResolveAuthEmailApplicationLinkTarget;
}> = {}): void {
    if (typeof app.authenticate !== "function") throw new Error("Account Security routes require app.authenticate");
    const authenticated = [app.authenticate, requirePresentUser];
    const authEmailDelivery = params.authEmailDelivery ?? createHomeAuthEmailDelivery();
    const resolveApplicationLinkTarget = params.resolveApplicationLinkTarget
        ?? (async () => ({ applicationOrigin: null, homeTarget: null, serverId: null }));
    const isEmailDeliveryReady = params.isEmailDeliveryReady
        ?? (async () => await resolveAuthEmailReadiness({ transportReady: await authEmailDelivery.isReady(), resolveApplicationLinkTarget }));

    app.post(ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.mutate"), connectionAuthFailureError: "invalid_token" }, schema: { body: PasswordMutationPreparationRequestV1Schema, response: { 200: PasswordMutationPreparationResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const body = request.body;
        const passwordHashWork = await runPasswordHashWork(async () => body.action === "remove"
            ? null
            : "newPlainPassword" in body
                ? await preparePlainAccountPasswordCredentialV1(body.newPlainPassword)
                : await prepareE2eeAccountPasswordCredentialV1(body.newE2eePassword));
        if (!passwordHashWork.ok) return reply.code(503).send({ error: "password_hash_overloaded" });
        const prepared = passwordHashWork.value;
        if (prepared && !prepared.ok) return reply.code(400).send({ error: "invalid_request" });
        const account = await db.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, publicKey: true } });
        if (!account || account.status !== "active") return reply.code(403).send({ error: "account-disabled" });
        if (account.encryptionMode === "e2ee"
            && prepared?.credential.kind === "e2ee_password_envelope"
            && !isE2eePasswordCredentialBoundToAccount(prepared.credential, account.publicKey)) {
            return reply.code(409).send({ error: "credential_inconsistent" });
        }
        const passwordMutation = mutation({
            action: body.action,
            accountId: request.userId,
            revision: body.expectedCredentialRevision,
            email: body.normalizedNativeEmail,
            credential: prepared?.credential ?? null,
            transitionRequestDigest: "transitionRequestDigest" in body ? body.transitionRequestDigest ?? null : null,
        });
        const challenge = account.encryptionMode === "e2ee"
            ? await issuePasswordMutationKeyChallengeV1({ env: requestHomeEnv, mutation: passwordMutation })
            : null;
        if (account.encryptionMode === "e2ee" && !challenge) return reply.code(503).send({ error: "challenge_unavailable" });
        if (!prepared) {
            if (!challenge) return reply.code(400).send({ error: "invalid_request" });
            return reply.send({ challenge });
        }
        return reply.send({ targetCredential: prepared.credential, ...(challenge ? { challenge } : {}) });
    });

    app.post(NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1, { attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.reset.submit") }, schema: { body: PlainPasswordResetSubmitRequestV1Schema, response: { 200: PlainPasswordResetSubmitResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const passwordHashWork = await runPasswordHashWork(async () => await preparePlainAccountPasswordCredentialV1(request.body.password));
        if (!passwordHashWork.ok) return reply.code(503).send({ error: "password_hash_overloaded" });
        const prepared = passwordHashWork.value;
        if (!prepared.ok) return reply.code(400).send({ error: "invalid_reset" });
        let result: { accountId: string; email: string } | "invalid" | "disabled" | "method_not_available";
        try {
            result = await inTx(async (tx) => {
                const operation = await readNativeAuthOneTimeOperation(tx, { purpose: "reset_plain_password", token: request.body.token });
                if (operation?.purpose !== "reset_plain_password") return "invalid" as const;
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, operation.accountId, "exclusive");
                const account = await tx.account.findUnique({ where: { id: operation.accountId }, select: { status: true, encryptionMode: true } });
                if (!account) return "invalid" as const;
                const identity = await tx.accountIdentity.findUnique({ where: { accountId_provider: { accountId: operation.accountId, provider: "email" } }, select: { id: true, providerUserId: true } });
                const current = await tx.accountPasswordCredential.findUnique({ where: { accountId: operation.accountId }, select: { revision: true, credential: true } });
                if (account.encryptionMode !== "plain" || !identity || identity.providerUserId !== operation.expectedNativeIdentity
                    || identity.id !== operation.nativeIdentityId
                    || !current || current.revision !== operation.credentialRevision
                    || !parseAccountPasswordCredentialV1(account.encryptionMode, current.credential).ok) return "invalid" as const;
                if (account.status !== "active") return "disabled" as const;
                if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                    env: requestHomeEnv,
                    methodId: "email_password",
                    actionId: "login",
                })) return "method_not_available" as const;
                const consumed = await consumeNativeAuthOneTimeOperationInTx(tx, { purpose: "reset_plain_password", token: request.body.token });
                if (!consumed) return "invalid" as const;
                const changed = await tx.accountPasswordCredential.updateMany({
                    where: { accountId: operation.accountId, revision: operation.credentialRevision },
                    data: { credential: prepared.credential, revision: { increment: 1 } },
                });
                if (changed.count !== 1) throw new InvalidResetMutation();
                await auth.signOutEverywhereInTx(tx, operation.accountId);
                await markAccountChanged(tx, { accountId: operation.accountId, kind: "account", entityId: "self" });
                return { accountId: operation.accountId, email: identity.providerUserId };
            });
        } catch (error) {
            if (error instanceof InvalidResetMutation
                || error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) result = "invalid";
            else throw error;
        }
        if (result === "disabled") return reply.code(403).send({ error: "account-disabled" });
        if (result === "method_not_available") return reply.code(403).send({ error: "method_not_available" });
        if (result === "invalid") return reply.code(400).send({ error: "invalid_reset" });
        if (typeof app.disconnectAccountSockets === "function") app.disconnectAccountSockets(result.accountId);
        await sendNotice({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, result.email, "password_reset");
        return reply.send({ v: 1, status: "password_reset" });
    });

    app.get(ACCOUNT_SECURITY_PATH_V1, { preHandler: app.authenticate, attachValidation: true, config: { allowApiToken: true, rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.security.read"), connectionAuthFailureError: "invalid_token" }, schema: { querystring: AccountSecurityGetRequestV1Schema, response: { 200: AccountSecurityGetResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const row = await db.account.findUnique({
            where: { id: request.userId },
            select: { encryptionMode: true, publicKey: true, AccountIdentity: { where: { provider: "email" }, select: { providerUserId: true } }, AccountPasswordCredential: { select: { revision: true, credential: true } } },
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        if (row.encryptionMode !== "plain" && row.encryptionMode !== "e2ee") {
            return reply.code(409).send({ error: "credential_inconsistent" });
        }
        if (row.AccountPasswordCredential) {
            const parsed = parseAccountPasswordCredentialV1(row.encryptionMode, row.AccountPasswordCredential.credential);
            if (!parsed.ok || (parsed.mode === "e2ee"
                && !isE2eePasswordCredentialBoundToAccount(parsed.credential, row.publicKey))) {
                return reply.code(409).send({ error: "credential_inconsistent" });
            }
        }
        return reply.send({ v: 1, encryptionMode: row.encryptionMode, nativeEmail: row.AccountIdentity[0]?.providerUserId ?? null, password: row.AccountPasswordCredential ? { status: "enrolled", revision: row.AccountPasswordCredential.revision } : { status: "not_enrolled", revision: null } });
    });

    app.post(ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.verify.requestAuthenticated"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountPasswordEnrollEmailRequestV1Schema, response: { 200: AccountEmailChangeRequestResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const recipient = normalizeVerifiedEmail(request.body.email);
        if (!recipient) return reply.code(400).send({ error: "invalid_request" });
        if (!await isEmailDeliveryReady()) return reply.code(503).send({ error: "email_delivery_unavailable" });
        const eligible = await inTx(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id: request.userId },
                select: {
                    status: true,
                    encryptionMode: true,
                    AccountIdentity: { where: { provider: "email" }, select: { id: true } },
                    AccountPasswordCredential: { select: { accountId: true } },
                },
            });
            if (!account || account.status !== "active") return "inconsistent" as const;
            if (account.AccountIdentity.length > 0 || account.AccountPasswordCredential) return "conflict" as const;
            if (account.encryptionMode !== "plain" && account.encryptionMode !== "e2ee") return "inconsistent" as const;
            const available = await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env: requestHomeEnv,
                methodId: "email_password",
                actionId: "connect",
                mode: account.encryptionMode === "plain" ? "keyless" : "keyed",
            });
            return available ? "ok" as const : "unavailable" as const;
        });
        if (eligible !== "ok") return reply.code(409).send({
            error: eligible === "inconsistent" ? "credential_inconsistent" : eligible,
        });
        const delivery = await requestNativeEmailVerification({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, {
            recipient,
            consumer: { kind: "password_enrollment", accountId: request.userId },
        });
        if (delivery.status !== "delivered" || delivery.delivery.status === "failed") {
            return reply.code(503).send({ error: "email_delivery_unavailable" });
        }
        return reply.send({ v: 1, status: "verification_sent" });
    });

    app.post(ACCOUNT_PASSWORD_ENROLL_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.mutate"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountPasswordEnrollRequestV1Schema, response: { 200: AccountPasswordMutationResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const body = request.body;
        const normalized = normalizeVerifiedEmail(body.email);
        if (!normalized) return reply.code(400).send({ error: "invalid_request" });
        const outcome = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, request.userId, "exclusive");
            const account = await tx.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, publicKey: true } });
            if (!account || account.status !== "active" || account.encryptionMode !== body.kind) return "inconsistent" as const;
            if (body.kind === "e2ee"
                && !isE2eePasswordCredentialBoundToAccount(body.targetCredential, account.publicKey)) return "inconsistent" as const;
            if (await tx.accountPasswordCredential.findUnique({ where: { accountId: request.userId } })) return "conflict" as const;
            if (await tx.accountIdentity.findUnique({ where: { accountId_provider: { accountId: request.userId, provider: "email" } } })) return "conflict" as const;
            const mailbox = await tx.accountEmail.findUnique({ where: { accountId_normalizedEmail: { accountId: request.userId, normalizedEmail: normalized.normalizedEmail } }, select: { accountId: true } });
            let mailboxOperation: Awaited<ReturnType<typeof readNativeAuthOneTimeOperation>> = null;
            if (!mailbox) {
                if (!body.verificationToken) return "reauthentication" as const;
                mailboxOperation = await readNativeAuthOneTimeOperation(tx, {
                    purpose: "verify_native_email",
                    token: body.verificationToken,
                });
                if (mailboxOperation?.purpose !== "verify_native_email"
                    || mailboxOperation.normalizedEmail !== normalized.normalizedEmail
                    || mailboxOperation.consumer.kind !== "password_enrollment"
                    || mailboxOperation.consumer.accountId !== request.userId) return "reauthentication" as const;
            }
            if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, { env: requestHomeEnv, methodId: "email_password", actionId: "connect", mode: body.kind === "plain" ? "keyless" : "keyed" })) return "unavailable" as const;
            if (body.kind === "plain") {
                const passwordMutation = mutation({
                    action: "connect",
                    accountId: request.userId,
                    revision: null,
                    email: normalized.normalizedEmail,
                    credential: body.targetCredential,
                });
                const proof = await consumeAccountPasswordEnrollmentExternalAuthProofInTx(tx, {
                    accountId: request.userId,
                    requestDigest: createPasswordCredentialMutationDigestV1(passwordMutation),
                    externalAuthProof: body.reauthentication,
                });
                if (!proof.ok || proof.provider === "email_password") return "reauthentication" as const;
            } else {
                const accepted = await consumePasswordMutationKeyChallengeInTx(tx, {
                    mutation: mutation({ action: "connect", accountId: request.userId, revision: null, email: normalized.normalizedEmail, credential: body.targetCredential }),
                    proof: body.proof,
                    env: requestHomeEnv,
                });
                if (!accepted) return "reauthentication" as const;
            }
            if (mailboxOperation && (!body.verificationToken || !await consumeNativeAuthOneTimeOperationInTx(tx, {
                purpose: "verify_native_email",
                token: body.verificationToken,
            }))) throw new PasswordEnrollmentReauthenticationAbort();
            if (!mailbox) await upsertVerifiedMailboxEvidenceInTx(tx, { accountId: request.userId, email: normalized });
            await linkIdentityInTx(tx, { accountId: request.userId, provider: "email", providerUserId: normalized.normalizedEmail, providerLogin: null, profile: {}, showOnProfile: false });
            await tx.accountPasswordCredential.create({ data: { accountId: request.userId, credential: body.targetCredential } });
            await markAccountChanged(tx, { accountId: request.userId, kind: "account", entityId: "self" });
            return "ok" as const;
        }, { isolationLevel: "Serializable" /* Password enrollment participates in final-login viability and provider-policy admission. */ }).catch((error) => {
            if (error instanceof PasswordEnrollmentReauthenticationAbort) return "reauthentication" as const;
            if (error instanceof ProviderAlreadyLinkedError || isPrismaUniqueConstraintError(error)) return "conflict" as const;
            throw error;
        });
        if (outcome !== "ok") return reply.code(outcome === "reauthentication" ? 403 : 409).send({
            error: outcome === "reauthentication"
                ? "reauthentication_required"
                : outcome === "inconsistent"
                    ? "credential_inconsistent"
                    : outcome,
        });
        await sendNotice({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, normalized.normalizedEmail, "password_connected");
        return reply.send({ v: 1, status: "enrolled" });
    });

    app.post(ACCOUNT_PASSWORD_CHANGE_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.mutate"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountPasswordChangeRequestV1Schema, response: { 200: AccountPasswordMutationResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const body = request.body;
        const snapshot = await db.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, AccountIdentity: { where: { provider: "email" }, select: { id: true, providerUserId: true } }, AccountPasswordCredential: { select: { revision: true, credential: true } } } });
        if (!snapshot || snapshot.status !== "active" || snapshot.encryptionMode !== body.kind || !snapshot.AccountPasswordCredential) return reply.code(409).send({ error: "credential_inconsistent" });
        if (snapshot.AccountPasswordCredential.revision !== body.expectedCredentialRevision) return reply.code(409).send({ error: "credential_revision_conflict" });
        const parsed = parseAccountPasswordCredentialV1(snapshot.encryptionMode, snapshot.AccountPasswordCredential.credential);
        if (!parsed.ok) return reply.code(409).send({ error: "credential_inconsistent" });
        if (body.kind === "plain") {
            if (parsed.mode !== "plain") return reply.code(409).send({ error: "credential_inconsistent" });
            const passwordVerification = await runPasswordHashWork(async () => await verifyPlainAccountPasswordCredentialV1(parsed.credential, body.currentPassword));
            if (!passwordVerification.ok) return reply.code(503).send({ error: "password_hash_overloaded" });
            if (!passwordVerification.value) return reply.code(403).send({ error: "authentication_failed" });
        }
        const passwordHashWork = await runPasswordHashWork(async () => body.kind === "plain"
            ? await preparePlainAccountPasswordCredentialV1(body.newPassword)
            : { ok: true as const, credential: body.targetCredential });
        if (!passwordHashWork.ok) return reply.code(503).send({ error: "password_hash_overloaded" });
        const prepared = passwordHashWork.value;
        if (!prepared.ok) return reply.code(400).send({ error: "invalid_request" });
        const email = snapshot.AccountIdentity[0]?.providerUserId ?? null;
        const passwordMutation = mutation({ action: body.kind === "e2ee" ? body.action : "change", accountId: request.userId, revision: body.expectedCredentialRevision, email, credential: prepared.credential });
        const outcome = await inTx(async (tx) => {
            // Account Security writers share this exclusive admission. Re-read
            // the identity lifetime and revision after waiting, before consuming
            // a keyed proof or installing the revision-checked replacement.
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, request.userId, "exclusive");
            const current = await tx.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, publicKey: true, AccountIdentity: { where: { provider: "email" }, select: { id: true, providerUserId: true } }, AccountPasswordCredential: { select: { revision: true, credential: true } } } });
            if (!current || current.status !== "active" || current.encryptionMode !== body.kind || current.AccountIdentity[0]?.providerUserId !== email || current.AccountIdentity[0]?.id !== snapshot.AccountIdentity[0]?.id || current.AccountPasswordCredential?.revision !== body.expectedCredentialRevision) return "conflict" as const;
            const parsedCurrent = parseAccountPasswordCredentialV1(current.encryptionMode, current.AccountPasswordCredential.credential);
            if (!parsedCurrent.ok || (parsedCurrent.mode === "e2ee"
                && !isE2eePasswordCredentialBoundToAccount(parsedCurrent.credential, current.publicKey))) return "inconsistent" as const;
            if (body.kind === "e2ee"
                && (prepared.credential.kind !== "e2ee_password_envelope"
                    || !isE2eePasswordCredentialBoundToAccount(prepared.credential, current.publicKey))) return "inconsistent" as const;
            if (body.kind === "e2ee" && !await consumePasswordMutationKeyChallengeInTx(tx, { mutation: passwordMutation, proof: body.proof, env: requestHomeEnv })) return "authentication" as const;
            const changed = await tx.accountPasswordCredential.updateMany({ where: { accountId: request.userId, revision: body.expectedCredentialRevision }, data: { credential: prepared.credential, revision: { increment: 1 } } });
            if (changed.count !== 1) throw new CredentialMutationConflict();
            await markAccountChanged(tx, { accountId: request.userId, kind: "account", entityId: "self" });
            return "ok" as const;
        }).catch((error) => {
            if (error instanceof CredentialMutationConflict) return "conflict" as const;
            throw error;
        });
        if (outcome === "authentication") return reply.code(403).send({ error: "authentication_failed" });
        if (outcome !== "ok") return reply.code(409).send({ error: outcome === "inconsistent" ? "credential_inconsistent" : "credential_revision_conflict" });
        await sendNotice({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, email, "password_changed");
        return reply.send({ v: 1, status: "updated" });
    });

    app.post(ACCOUNT_PASSWORD_REMOVE_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.mutate"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountPasswordRemoveRequestV1Schema, response: { 200: AccountPasswordMutationResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const body = request.body;
        const snapshot = await db.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, AccountIdentity: { where: { provider: "email" }, select: { id: true, providerUserId: true } }, AccountPasswordCredential: { select: { revision: true, credential: true } } } });
        if (!snapshot || snapshot.status !== "active" || snapshot.encryptionMode !== body.kind || snapshot.AccountPasswordCredential?.revision !== body.expectedCredentialRevision) return reply.code(409).send({ error: "credential_revision_conflict" });
        const parsed = parseAccountPasswordCredentialV1(snapshot.encryptionMode, snapshot.AccountPasswordCredential.credential);
        if (!parsed.ok) return reply.code(409).send({ error: "credential_inconsistent" });
        if (body.kind === "plain") {
            if (parsed.mode !== "plain") return reply.code(409).send({ error: "credential_inconsistent" });
            const passwordVerification = await runPasswordHashWork(async () => await verifyPlainAccountPasswordCredentialV1(parsed.credential, body.currentPassword));
            if (!passwordVerification.ok) return reply.code(503).send({ error: "password_hash_overloaded" });
            if (!passwordVerification.value) return reply.code(403).send({ error: "authentication_failed" });
        }
        const email = snapshot.AccountIdentity[0]?.providerUserId ?? null;
        const passwordMutation = mutation({ action: "remove", accountId: request.userId, revision: body.expectedCredentialRevision, email, credential: null });
        const outcome = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, request.userId, "exclusive");
            const account = await tx.account.findUnique({ where: { id: request.userId }, select: { status: true, encryptionMode: true, publicKey: true, homeRole: true } });
            const identity = await tx.accountIdentity.findUnique({ where: { accountId_provider: { accountId: request.userId, provider: "email" } }, select: { id: true, providerUserId: true } });
            const current = await tx.accountPasswordCredential.findUnique({ where: { accountId: request.userId }, select: { revision: true, credential: true } });
            if (!account || account.status !== "active" || account.encryptionMode !== body.kind || identity?.providerUserId !== email || identity?.id !== snapshot.AccountIdentity[0]?.id || !current || current.revision !== body.expectedCredentialRevision) return "conflict" as const;
            const parsedCurrent = parseAccountPasswordCredentialV1(account.encryptionMode, current.credential);
            if (!parsedCurrent.ok || (parsedCurrent.mode === "e2ee"
                && !isE2eePasswordCredentialBoundToAccount(parsedCurrent.credential, account.publicKey))) return "inconsistent" as const;
            const methods = await resolveEffectiveHomeAuthMethodsInTx(tx, { env: requestHomeEnv });
            const facts = await readAccountLoginViabilityFactsAfterProviderRemovalInTx(tx, { accountId: request.userId, env: requestHomeEnv, excludedProviderId: "email", identityEligibility: "current" });
            if (methods.status !== "ready" || !facts) return "last_login_method" as const;
            const otherActiveOwners = account.homeRole === "owner" ? await countActiveHomeOwnersInTx(tx, { excludeAccountId: request.userId }) : 0;
            const viability = checkAccountRetainsLoginRouteForDecisions(methods.decisions, { ...facts, hasPasswordCredential: false, isLastHomeAdministrator: account.homeRole === "owner" && otherActiveOwners === 0 }, { requireLastAdministratorProof: true });
            if (!viability.ok) return "last_login_method" as const;
            if (body.kind === "e2ee" && !await consumePasswordMutationKeyChallengeInTx(tx, { mutation: passwordMutation, proof: body.proof, env: requestHomeEnv })) return "authentication" as const;
            const deleted = await tx.accountPasswordCredential.deleteMany({ where: { accountId: request.userId, revision: body.expectedCredentialRevision } });
            if (deleted.count !== 1) throw new CredentialMutationConflict();
            await unlinkIdentityInTx(tx, { accountId: request.userId, provider: "email" });
            await markAccountChanged(tx, { accountId: request.userId, kind: "account", entityId: "self" });
            return "ok" as const;
        }).catch((error) => {
            if (error instanceof CredentialMutationConflict) return "conflict" as const;
            throw error;
        });
        if (outcome === "authentication") return reply.code(403).send({ error: "authentication_failed" });
        if (outcome !== "ok") return reply.code(409).send({
            error: outcome === "conflict"
                ? "credential_revision_conflict"
                : outcome === "inconsistent"
                    ? "credential_inconsistent"
                    : outcome,
        });
        await sendNotice({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, email, "password_removed");
        return reply.send({ v: 1, status: "removed" });
    });

    app.post(ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.verify.requestAuthenticated"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountEmailChangeRequestV1Schema, response: { 200: AccountEmailChangeRequestResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const recipient = normalizeVerifiedEmail(request.body.email);
        if (!recipient) return reply.code(400).send({ error: "invalid_request" });
        if (!await isEmailDeliveryReady()) return reply.code(503).send({ error: "email_delivery_unavailable" });
        const current = await db.account.findUnique({ where: { id: request.userId }, select: { status: true, AccountIdentity: { where: { provider: "email" }, select: { id: true, providerUserId: true } } } });
        const currentIdentity = current?.AccountIdentity[0];
        const currentEmail = current?.AccountIdentity[0]?.providerUserId ?? null;
        if (!current || current.status !== "active" || !currentIdentity || !currentEmail) return reply.code(409).send({ error: "identity_changed" });
        const delivery = await requestNativeEmailVerification({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, {
            recipient,
            consumer: { kind: "sign_in_email_change", accountId: request.userId, nativeIdentityId: currentIdentity.id, expectedNativeIdentity: currentEmail },
        });
        if (delivery.status !== "delivered" || delivery.delivery.status === "failed") {
            return reply.code(503).send({ error: "email_delivery_unavailable" });
        }
        return reply.send({ v: 1, status: "verification_sent" });
    });

    app.post(ACCOUNT_EMAIL_CHANGE_PATH_V1, { preHandler: authenticated, attachValidation: true, config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.password.mutate"), connectionAuthFailureError: "invalid_token" }, schema: { body: AccountEmailChangeCompleteRequestV1Schema, response: { 200: AccountPasswordMutationResponseV1Schema, ...ACCOUNT_SECURITY_ROUTE_ERROR_RESPONSES } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const result = await inTx(async (tx) => {
            const operation = await readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: request.body.verificationToken });
            if (operation?.purpose !== "verify_native_email"
                || operation.consumer.kind !== "sign_in_email_change"
                || operation.consumer.accountId !== request.userId
                || !operation.normalizedEmail) return null;
            // Serialize the identity mutation with password reset and every other
            // Account Security writer. In particular, a reset bearer bound to the
            // former native identity cannot race past a committed email change.
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, request.userId, "exclusive");
            const account = await tx.account.findUnique({ where: { id: request.userId }, select: { status: true } });
            const identity = await tx.accountIdentity.findUnique({ where: { accountId_provider: { accountId: request.userId, provider: "email" } }, select: { id: true, providerUserId: true } });
            if (!account || account.status !== "active" || !identity
                || identity.id !== operation.consumer.nativeIdentityId
                || identity.providerUserId !== operation.consumer.expectedNativeIdentity) return "conflict" as const;
            if (!await consumeNativeAuthOneTimeOperationInTx(tx, { purpose: "verify_native_email", token: request.body.verificationToken })) return null;
            await linkIdentityInTx(tx, { accountId: request.userId, provider: "email", providerUserId: operation.normalizedEmail, providerLogin: null, profile: {}, showOnProfile: false });
            const verifiedEmail = normalizeVerifiedEmail(operation.normalizedEmail);
            if (!verifiedEmail) throw new Error("verified_native_email_operation_not_normalized");
            await upsertVerifiedMailboxEvidenceInTx(tx, { accountId: request.userId, email: verifiedEmail });
            await markAccountChanged(tx, { accountId: request.userId, kind: "account", entityId: "self" });
            return operation.normalizedEmail;
        }).catch((error) => {
            if (error instanceof ProviderAlreadyLinkedError
                || error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError
                || isPrismaUniqueConstraintError(error)) return "conflict" as const;
            throw error;
        });
        if (result === null) return reply.code(400).send({ error: "verification_invalid" });
        if (result === "conflict") return reply.code(409).send({ error: "identity_changed" });
        await sendNotice({ delivery: authEmailDelivery, resolveApplicationLinkTarget }, result, "sign_in_email_changed");
        return reply.send({ v: 1, status: "updated" });
    });
}

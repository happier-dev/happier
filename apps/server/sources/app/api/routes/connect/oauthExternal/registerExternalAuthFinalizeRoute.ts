import { createHash, randomUUID } from "node:crypto";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { z } from "zod";

import { type Fastify } from "../../../types";
import {
    prepareExternalIdentityConnection,
} from "@/app/auth/providers/identity";
import { auth } from "@/app/auth/auth";
import { isAuthSignupProviderEnabled } from "@/app/auth/authPolicy";
import {
    isEffectiveHomeAuthMethodActionEnabled,
    isEffectiveHomeAuthMethodActionEnabledInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import {
    consumeValidOAuthPendingInTx,
    deleteOAuthPendingBestEffort,
    loadValidOAuthPending,
} from "../connectRoutes.oauthPending";
import { isProviderResetEnabled } from "./oauthExternalConfig";
import {
    OAuthProviderConfigurationChangedError,
    PROVIDER_ALREADY_LINKED_ERROR,
    RECOVERY_DISABLED_ERROR,
} from "./oauthExternalErrors";
import { authPendingSchema, hasInvalidOAuthSecurityBinding } from "./oauthExternalSchemas";
import {
    ExternalOAuthFinalizeAuthRequestSchema,
    ExternalOAuthFinalizeAuthSuccessResponseSchema,
    AccountDirectoryRouteErrorResponseV1Schema,
} from "@happier-dev/protocol";
import { shouldDenyPublicSignupProvisioningAction } from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import {
    admitAccountContentKey,
    verifyAccountContentKeyBinding,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import { inTx } from "@/storage/inTx";
import {
    HomeGovernanceInvariantError,
    replaceAccountForProviderResetInTx,
    type ProviderResetAccountReplacementResult,
} from "@/app/home/governance/accountReplacement";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { provisionFreshAccountInTx } from "@/app/auth/provisionFreshAccountInTx";
import { isCurrentAccountDirectoryOAuthTarget } from "./accountDirectoryOAuthTarget";
import {
    ensureSameServiceHomeEntryInTx,
    prepareSameServiceHomeEntry,
} from "@/app/accountDirectory/accountDirectoryService";
import { oauthExternalFinalizeErrorHandler } from "./oauthExternalFinalizeErrorHandler";
import {
    isTeamOwnedConnectionAdmission,
    requireCurrentOAuthPendingRuntime,
    requireCurrentOAuthPendingRuntimeInTx,
} from "./oauthSecurityBinding";
import { requireTeamOAuthAdmissionInTx, TeamOAuthAdmissionAbort } from "@/app/teams/memberships/teamOAuthAdmission";
import { readOAuthAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";
import { upsertVerifiedMailboxEvidenceInTx } from "@/app/auth/verifiedMailboxEvidence";
import {
    claimTeamInvitationPostAuthContinuationInTx,
    discardClaimedTeamInvitationPostAuthContinuationInTx,
} from "@/app/teams/invitations/postAuthContinuation";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

type ProviderResetAccountReplacementRejection = Extract<
    ProviderResetAccountReplacementResult,
    Readonly<{ status: "rejected" }>
>;

class ProviderResetAccountReplacementRejected extends Error {
    constructor(readonly rejection: ProviderResetAccountReplacementRejection) {
        super(rejection.code);
        this.name = "ProviderResetAccountReplacementRejected";
    }
}

export function registerExternalAuthFinalizeRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/finalize", {
        errorHandler: oauthExternalFinalizeErrorHandler,
        schema: {
            params: z.object({ provider: z.string() }),
            body: ExternalOAuthFinalizeAuthRequestSchema,
            response: {
                200: ExternalOAuthFinalizeAuthSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-proof", "invalid-public-key", "invalid-signature", "username-required", "invalid-username"]) }),
                403: z.union([
                    z.object({ error: z.enum(["signup-provider-disabled", "forbidden", "not-eligible", RECOVERY_DISABLED_ERROR, "team_authentication_required"]) }),
                    AccountDirectoryRouteErrorResponseV1Schema,
                ]),
                503: z.object({ error: z.literal("team_authentication_unavailable") }),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.union([
                    z.object({ error: z.literal("auth_provider_configuration_changed") }),
                    AccountDirectoryRouteErrorResponseV1Schema,
                    z.object({ error: z.literal("username-taken") }),
                    z.object({ error: z.literal(PROVIDER_ALREADY_LINKED_ERROR), provider: z.string() }),
                    z.object({ error: z.literal("content_public_key_mismatch") }),
                    // An ambiguous duplicate membership is a merge, not a
                    // transfer. It is refused before any row is mutated and is
                    // reported as a typed conflict rather than a new success
                    // shape; released clients fall back on the non-2xx path.
                    z.object({
                        error: z.literal("team_membership_transfer_conflict"),
                        details: z.object({ teamIds: z.array(z.string()) }).strict(),
                    }).strict(),
                ]),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const availableRuntime = await resolveOAuthRuntimeById(requestHomeEnv, providerId);
        if (!availableRuntime && !await loadValidOAuthPending(request.body.pending)) {
            return reply.code(404).send({ error: "unsupported-provider" });
        }

        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        let publicKeyBytes: Uint8Array;
        let challengeBytes: Uint8Array;
        let signatureBytes: Uint8Array;
        try {
            publicKeyBytes = privacyKit.decodeBase64(request.body.publicKey);
            challengeBytes = privacyKit.decodeBase64(request.body.challenge);
            signatureBytes = privacyKit.decodeBase64(request.body.signature);
        } catch {
            return reply.code(400).send({ error: "invalid-public-key" });
        }
        if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
            return reply.code(400).send({ error: "invalid-public-key" });
        }
        if (signatureBytes.length !== tweetnacl.sign.signatureLength) {
            return reply.code(400).send({ error: "invalid-signature" });
        }
        const signatureOk = tweetnacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
        if (!signatureOk) {
            return reply.code(400).send({ error: "invalid-signature" });
        }
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(publicKeyBytes));

        let contentKeyBinding: VerifiedAccountContentKeyBinding | null = null;
        if (request.body.contentPublicKey && request.body.contentPublicKeySig) {
            let contentPublicKey: Uint8Array;
            let contentPublicKeySignature: Uint8Array;
            try {
                contentPublicKey = privacyKit.decodeBase64(request.body.contentPublicKey);
                contentPublicKeySignature = privacyKit.decodeBase64(
                    request.body.contentPublicKeySig,
                );
            } catch {
                return reply.code(400).send({ error: "invalid-signature" });
            }
            contentKeyBinding = verifyAccountContentKeyBinding({
                accountSigningPublicKey: publicKeyBytes,
                contentPublicKey,
                contentPublicKeySignature,
            });
            if (!contentKeyBinding) {
                return reply.code(400).send({ error: "invalid-signature" });
            }
        }

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.code(400).send({ error: "invalid-pending" });

        let parsedValue: z.infer<typeof authPendingSchema>;
        try {
            const value: unknown = JSON.parse(pending.value);
            const parsed = authPendingSchema.safeParse(value);
            if (!parsed.success) {
                await deleteOAuthPendingBestEffort(pendingKey);
                if (hasInvalidOAuthSecurityBinding(value)) {
                    return reply.code(409).send({ error: "auth_provider_configuration_changed" });
                }
                return reply.code(400).send({ error: "invalid-pending" });
            }
            parsedValue = parsed.data;
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const isAccountDirectory =
            (parsedValue as { v?: unknown }).v === 2
            && (parsedValue as { purpose?: unknown }).purpose
                === "account_directory";
        const pendingPurpose = parsedValue.securityBinding?.purpose ?? null;
        const isTeamAdmission = pendingPurpose === "team_admission";
        const homeAdmission = isTeamAdmission ? parsedValue.securityBinding?.admission ?? undefined : undefined;
        const isKeyedAccountDirectory =
            isAccountDirectory
            && (parsedValue as { authMode?: unknown }).authMode
                === "keyed";
        if (isAccountDirectory && !isKeyedAccountDirectory) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }
        if (
            isKeyedAccountDirectory
            && !await isCurrentAccountDirectoryOAuthTarget(parsedValue)
        ) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }
        const pendingFormat =
            (parsedValue as { v?: unknown }).v === 2
                ? ("v2" as const)
                : (typeof (parsedValue as any)?.publicKeyHex === "string" && (parsedValue as any).publicKeyHex.trim())
                    ? ("legacy_keyed" as const)
                    : null;
        if (!pendingFormat) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }
        if (pendingFormat === "v2" && !isKeyedAccountDirectory) {
            const proof = request.body.proof?.toString?.().trim?.() ?? "";
            if (!proof) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-proof" });
            }
            const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");
            if (!((parsedValue as any).proofHash) || proofHash !== (parsedValue as any).proofHash) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-proof" });
            }
        }

        if (parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (
            (pendingFormat === "legacy_keyed" || isKeyedAccountDirectory)
            && (parsedValue as { publicKeyHex?: unknown }).publicKeyHex
                !== publicKeyHex
        ) {
            return reply.code(403).send({ error: "forbidden" });
        }

        const bindingInput = {
            env: requestHomeEnv,
            providerId, pendingKey, binding: parsedValue.securityBinding,
            purpose: isAccountDirectory ? "account_directory" : pendingPurpose,
        } as const;
        const provider = await requireCurrentOAuthPendingRuntime(bindingInput);
        if (!isAccountDirectory && !isTeamAdmission && !await isEffectiveHomeAuthMethodActionEnabled({
            env: requestHomeEnv,
            methodId: providerId,
            actionId: "provision",
            mode: "keyed",
        })) {
            return reply.code(403).send({ error: "signup-provider-disabled" });
        }

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            // An identity-proof-only provider persists no token in the continuation.
            const tokenBytes = parsedValue.accessTokenEnc
                ? privacyKit.decodeBase64(parsedValue.accessTokenEnc)
                : null;
            accessToken = tokenBytes === null
                ? ""
                : pendingFormat === "v2" && !isKeyedAccountDirectory
                    ? decryptString(["auth", "external", providerId, "pending_v2", pendingKey, "token"], tokenBytes)
                    : decryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex], tokenBytes);
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(
                    pendingFormat === "v2" && !isKeyedAccountDirectory
                        ? ["auth", "external", providerId, "pending_v2", pendingKey, "refresh"]
                        : ["auth", "external", providerId, "pending", pendingKey, publicKeyHex, "refresh"],
                    refreshBytes,
                );
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                pendingFormat === "v2" && !isKeyedAccountDirectory
                    ? ["auth", "external", providerId, "pending_v2", pendingKey, "profile"]
                    : ["auth", "external", providerId, "pending", pendingKey, publicKeyHex, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const providerUserId = provider.getProviderUserId(pendingProfile);
        if (!providerUserId) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        let existingAccount = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { id: true, username: true, contentPublicKey: true },
        });

        const alreadyLinked = await db.accountIdentity.findFirst({
            where: {
                provider: providerId,
                providerUserId,
                ...(existingAccount ? { NOT: { accountId: existingAccount.id } } : {}),
            },
            select: { id: true, accountId: true, showOnProfile: true },
        });

        if (
            isAccountDirectory
            && (
                parsedValue.securityBinding?.provider.source === "managed"
                || !isAuthSignupProviderEnabled(requestHomeEnv, providerId)
            )
        ) {
            return reply.code(403).send({ error: "signup-provider-disabled" });
        }

        const sameServiceBootstrapPreparation = isAccountDirectory
            ? await prepareSameServiceHomeEntry({})
            : null;
        if (
            sameServiceBootstrapPreparation?.status === "not_dual_role"
            && sameServiceBootstrapPreparation.reason === "server_identity_mismatch"
        ) {
            throw new Error("Same-service Home descriptor identity mismatch");
        }

        if (isAccountDirectory && alreadyLinked) {
            const token = await inTx(async (tx) => {
                await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                const consumed = await consumeValidOAuthPendingInTx(
                    tx,
                    pending,
                );
                if (!consumed) return null;
                if (sameServiceBootstrapPreparation) {
                    await ensureSameServiceHomeEntryInTx(tx, {
                        accountId: alreadyLinked.accountId,
                        preparation: sameServiceBootstrapPreparation,
                    });
                }
                const authenticationEvidence = parsedValue.securityBinding?.provider
                    ? await readOAuthAuthenticationEvidenceInTx(tx, {
                        accountId: alreadyLinked.accountId,
                        providerId,
                        runtimeFingerprint: parsedValue.securityBinding.provider.runtimeFingerprint,
                    })
                    : undefined;
                if (parsedValue.securityBinding && !authenticationEvidence) throw new Error("invalid-pending");
                return await auth.createTokenInTx(
                    tx,
                    alreadyLinked.accountId,
                    undefined,
                    // Canonical closed provenance: the restricted directory
                    // kind always travels with present_user authority.
                    {
                        kind: "account_directory",
                        authority: "present_user",
                        authenticationEvidence,
                    },
                );
            });
            if (!token) {
                return reply.code(400).send({ error: "invalid-pending" });
            }
            return reply.send({ success: true, token });
        }

        if (!existingAccount && !alreadyLinked && !homeAdmission) {
            const blocked = shouldDenyPublicSignupProvisioningAction({
                env: requestHomeEnv,
                requestIp: request.ip,
                methodId: providerId,
                mode: "keyed",
            });
            if (blocked) {
                return reply.code(403).send({ error: "forbidden" });
            }
        }

        const resetRequested = request.body.reset === true;
        if (isTeamAdmission && resetRequested) {
            throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");
        }
        if (isAccountDirectory && resetRequested) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (alreadyLinked && !resetRequested) {
            return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
        }

        const usernameProvidedRaw = request.body.username?.toString().trim() || "";
        let desiredUsername: string | null = null;

        // Only the identity and the display name are read here. The feed
        // cursor and Home role are inherited by the replacement coordinator
        // from the row it rereads inside the replacement transaction.
        let oldAccountForReset: { id: string; username: string | null } | null = null;
        if (alreadyLinked && resetRequested) {
            if (!isProviderResetEnabled(requestHomeEnv)) {
                return reply.code(403).send({ error: RECOVERY_DISABLED_ERROR });
            }
            oldAccountForReset = await db.account.findUnique({
                where: { id: alreadyLinked.accountId },
                select: { id: true, username: true },
            });
            if (!oldAccountForReset) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
        }

        if (usernameProvidedRaw) {
            const validation = validateUsername(usernameProvidedRaw, requestHomeEnv);
            if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
            desiredUsername = validation.username;
        } else if (oldAccountForReset?.username) {
            desiredUsername = oldAccountForReset.username;
        } else {
            const required = parsedValue.usernameRequired === true;
            if (required) return reply.code(400).send({ error: "username-required" });

            const suggested = parsedValue.suggestedUsername?.toString().trim() || "";
            if (!suggested) return reply.code(400).send({ error: "username-required" });

            const validation = validateUsername(suggested, requestHomeEnv);
            if (!validation.ok) return reply.code(400).send({ error: "username-required" });
            desiredUsername = validation.username;
        }

        const taken = await db.account.findFirst({
            where: {
                username: desiredUsername,
                NOT: oldAccountForReset ? { id: oldAccountForReset.id } : { publicKey: publicKeyHex },
            },
            select: { id: true },
        });
        if (taken) {
            return reply.code(409).send({ error: "username-taken" });
        }

        if (alreadyLinked && resetRequested && oldAccountForReset) {
            const oldAccountId = oldAccountForReset.id;

            const identitySnapshot = await db.accountIdentity.findUnique({
                where: { id: alreadyLinked.id },
                select: { id: true },
            });
            if (!identitySnapshot) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }

            await requireCurrentOAuthPendingRuntime(bindingInput);

            // The replacement Account ID is chosen before the external identity
            // preparation that needs it, exactly as the fresh-signup branch
            // below does. The row itself is inserted inside the replacement
            // transaction, so a failure anywhere rolls the whole replacement
            // back and leaves the replaced Account authoritative. There is no
            // Account created outside the transaction and therefore no
            // compensating erasure to run.
            const replacementAccountId = randomUUID();

            let replacementOutcome:
                | Readonly<{ status: "replaced"; token: string }>
                | Readonly<{
                    status: "rejected";
                    code: "home_account_not_found" | "home_account_inactive" | "team_membership_transfer_conflict";
                    details?: Readonly<{ teamIds: readonly string[] }>;
                }>;
            try {
                const prepared = await prepareExternalIdentityConnection({
                    reference: parsedValue.securityBinding?.provider,
                    providerId, ctx: Context.create(replacementAccountId), profile: pendingProfile,
                    accessToken, refreshToken, preferredUsername: desiredUsername,
                    transferFromAccountId: oldAccountId,
                });
                replacementOutcome = await inTx(async (tx) => {
                    await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                    if (!isTeamAdmission && !await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                        env: requestHomeEnv,
                        methodId: providerId,
                        actionId: "provision",
                        mode: "keyed",
                    })) throw new OAuthProviderConfigurationChangedError(pendingKey);
                    if (!await consumeValidOAuthPendingInTx(tx, pending)) throw new Error('invalid-pending');

                    // One canonical coordinator owns the whole replacement:
                    // Home role inheritance, membership-lifetime transfer with
                    // its collision refusal, the last-active-owner guard, and
                    // the canonical lifecycle retirement of the replaced
                    // Account. This route contributes only its own social and
                    // identity domains.
                    const replacement = await replaceAccountForProviderResetInTx(tx, {
                        oldAccountId,
                        replacement: {
                            accountId: replacementAccountId,
                            publicKey: publicKeyHex,
                            contentPublicKey: contentKeyBinding?.contentPublicKey ?? null,
                            contentPublicKeySignature: contentKeyBinding?.contentPublicKeySignature ?? null,
                        },
                        desiredUsername,
                        retireReplacedAccountInTx: async (retireTx) => {
                            const retired = await setAccountStatusInTx(retireTx, {
                                actorAccountId: replacementAccountId,
                                targetAccountId: oldAccountId,
                                status: "disabled",
                                authority: "provider_account_replacement",
                            });
                            if (retired.status === "rejected") {
                                throw new HomeGovernanceInvariantError(
                                    `Provider reset could not retire the replaced Account (${retired.code}).`,
                                );
                            }
                        },
                    });
                    // The pending proof was consumed earlier in this transaction.
                    // A rejected replacement must abort so that a failed finalization
                    // cannot commit that one-shot authority as its only durable effect.
                    if (replacement.status === "rejected") {
                        throw new ProviderResetAccountReplacementRejected(replacement);
                    }

                    await prepared.connectInTx(tx);
                    await tx.userRelationship.updateMany({ where: { fromUserId: oldAccountId }, data: { fromUserId: replacementAccountId } });
                    await tx.userRelationship.updateMany({ where: { toUserId: oldAccountId }, data: { toUserId: replacementAccountId } });
                    await tx.userFeedItem.updateMany({ where: { userId: oldAccountId }, data: { userId: replacementAccountId } });

                    const authenticationEvidence = parsedValue.securityBinding?.provider
                        ? await readOAuthAuthenticationEvidenceInTx(tx, {
                            accountId: replacementAccountId,
                            providerId,
                            runtimeFingerprint: parsedValue.securityBinding.provider.runtimeFingerprint,
                        })
                        : undefined;
                    if (parsedValue.securityBinding && !authenticationEvidence) throw new Error("invalid-pending");
                    const token = await auth.createTokenInTx(tx, replacementAccountId, undefined, {
                        kind: "account",
                        authority: "present_user",
                        authenticationEvidence,
                    });
                    return { status: "replaced" as const, token };
                });
            } catch (error) {
                if (error instanceof ProviderResetAccountReplacementRejected) {
                    replacementOutcome = error.rejection;
                } else if (error instanceof Error && error.message === 'invalid-pending') {
                    return reply.code(400).send({ error: 'invalid-pending' });
                } else if (error instanceof Error && error.message === "not-eligible") {
                    await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                    return reply.code(403).send({ error: "not-eligible" });
                } else if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                } else {
                    throw error;
                }
            }

            if (replacementOutcome.status === "rejected") {
                // The Home's hold on the replaced Account, answered only after
                // complete proof of a verified provider identity, in the same
                // shape every other inactive-Account refusal on this route
                // already takes. The one-shot pending stays intact: its
                // transaction rolled back, so a lifted suspension can retry.
                if (replacementOutcome.code === "home_account_inactive") {
                    return reply.code(403).send({ error: "account-disabled" });
                }
                if (replacementOutcome.code === "team_membership_transfer_conflict") {
                    return reply.code(409).send({
                        error: "team_membership_transfer_conflict",
                        details: { teamIds: [...(replacementOutcome.details?.teamIds ?? [])] },
                    });
                }
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }

            return reply.send({ success: true, token: replacementOutcome.token });
        }

        if (!existingAccount && !alreadyLinked) {
            const proposedAccountId = randomUUID();
            let preparedIdentityConnection: Awaited<
                ReturnType<typeof prepareExternalIdentityConnection>
            >;
            try {
                preparedIdentityConnection = await prepareExternalIdentityConnection({
                    reference: parsedValue.securityBinding?.provider,
                    providerId,
                    ctx: Context.create(proposedAccountId),
                    profile: pendingProfile,
                    accessToken,
                    refreshToken,
                    preferredUsername: desiredUsername,
                });
            } catch (error) {
                if (error instanceof Error && error.message === "not-eligible") {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                }
                throw error;
            }

            let freshAccountWrite:
                | Readonly<{ status: "provider_disabled" }>
                | Readonly<{ status: "provision_denied" }>
                | Readonly<{ status: "invalid_pending" }>
                | Readonly<{ status: "written"; token: string }>
                | null = null;
            try {
                freshAccountWrite = await inTx(async (tx) => {
                    await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                    // The current policy decision and exact pending delete are
                    // the first transaction operations. Every durable effect
                    // below rolls back if either authority has gone stale.
                    if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                        env: requestHomeEnv,
                        methodId: providerId,
                        actionId: "provision",
                        mode: "keyed",
                        ...(homeAdmission ? { admission: homeAdmission } : {}),
                    })) {
                        if (isTeamAdmission) {
                            throw new TeamOAuthAdmissionAbort("team_authentication_required");
                        }
                        return { status: "provider_disabled" as const };
                    }
                    if (!homeAdmission && shouldDenyPublicSignupProvisioningAction({
                        env: requestHomeEnv,
                        requestIp: request.ip,
                        methodId: providerId,
                        mode: "keyed",
                    })) return { status: "provision_denied" as const };
                    const consumed = await consumeValidOAuthPendingInTx(tx, pending);
                    if (!consumed) return { status: "invalid_pending" as const };

                    const account = await provisionFreshAccountInTx(tx, {
                        insertSemantics: { kind: "must_create", accountId: proposedAccountId },
                        publicKey: publicKeyHex,
                        encryptionMode: "e2ee",
                        username: desiredUsername,
                        contentKeyBinding,
                        identityConnection: preparedIdentityConnection,
                        verifiedMailbox: preparedIdentityConnection.verifiedMailbox,
                        directoryPreparation: sameServiceBootstrapPreparation,
                        ...(isTeamAdmission ? {
                            teamOAuthAdmission: {
                                env: requestHomeEnv,
                                provider: parsedValue.securityBinding?.provider,
                                connection: parsedValue.securityBinding?.connection,
                                source: parsedValue.securityBinding?.admission,
                            },
                        } : {}),
                    });
                    const authenticationEvidence = isTeamAdmission
                        ? await readOAuthAuthenticationEvidenceInTx(tx, {
                            accountId: account.id,
                            providerId,
                            runtimeFingerprint: parsedValue.securityBinding!.provider.runtimeFingerprint,
                            ...(parsedValue.securityBinding!.provider.context.kind === "team" && parsedValue.securityBinding!.connection?.id
                                ? { teamConnectionId: parsedValue.securityBinding!.connection.id }
                                : {}),
                        })
                        : parsedValue.securityBinding?.provider
                            ? await readOAuthAuthenticationEvidenceInTx(tx, {
                                accountId: account.id,
                                providerId,
                                runtimeFingerprint: parsedValue.securityBinding.provider.runtimeFingerprint,
                            })
                            : undefined;
                    if (parsedValue.securityBinding && !authenticationEvidence) throw new Error("invalid-pending");
                    const token = await auth.createTokenInTx(tx, account.id, undefined, {
                        kind: isAccountDirectory ? "account_directory" : "account",
                        authority: "present_user",
                        authenticationEvidence,
                    });
                    return { status: "written" as const, token };
                });
            } catch (error) {
                let recoveredEqualKeyRace = false;
                if (isPrismaUniqueConstraintError(error) && contentKeyBinding) {
                    const racedAccount = await db.account.findUnique({
                        where: { publicKey: publicKeyHex },
                        select: { id: true, username: true, contentPublicKey: true },
                    });
                    if (
                        racedAccount?.contentPublicKey
                        && !Buffer.from(racedAccount.contentPublicKey).equals(
                            Buffer.from(contentKeyBinding.contentPublicKey),
                        )
                    ) {
                        return reply.code(409).send({ error: "content_public_key_mismatch" });
                    }
                    if (racedAccount) {
                        // The losing must-create transaction rolled back every
                        // effect, including pending consumption. Continue via
                        // the canonical existing-Account branch below so the
                        // exact equal-key winner is finalized atomically.
                        existingAccount = racedAccount;
                        recoveredEqualKeyRace = true;
                    }
                }
                if (error instanceof Error && error.message === "content_public_key_mismatch") {
                    return reply.code(409).send({ error: "content_public_key_mismatch" });
                }
                if (error instanceof Error && error.message === "invalid_content_public_key_binding") {
                    return reply.code(400).send({ error: "invalid-signature" });
                }
                if (error instanceof Error && error.message === "not-eligible") {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                }
                if (!recoveredEqualKeyRace) throw error;
            }

            if (freshAccountWrite) {
                if (freshAccountWrite.status === "provider_disabled") {
                    return reply.code(403).send({ error: "signup-provider-disabled" });
                }
                if (freshAccountWrite.status === "provision_denied") {
                    return reply.code(403).send({ error: "forbidden" });
                }
                if (freshAccountWrite.status === "invalid_pending") {
                    return reply.code(400).send({ error: "invalid-pending" });
                }
                return reply.send({ success: true, token: freshAccountWrite.token });
            }
        }

        if (existingAccount && !alreadyLinked) {
            let preparedIdentityConnection: Awaited<
                ReturnType<typeof prepareExternalIdentityConnection>
            >;
            try {
                preparedIdentityConnection = await prepareExternalIdentityConnection({
                    reference: parsedValue.securityBinding?.provider,
                    providerId,
                    ctx: Context.create(existingAccount.id),
                    profile: pendingProfile,
                    accessToken,
                    refreshToken,
                    preferredUsername: desiredUsername,
                });
            } catch (error) {
                if (error instanceof Error && error.message === "not-eligible") {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                }
                throw error;
            }

            let existingAccountWrite:
                | Readonly<{ status: "provider_disabled" }>
                | Readonly<{ status: "invalid_pending" }>
                | Readonly<{
                    status: "written";
                    token: string;
                    teamInvitationContinuation?: import("@happier-dev/protocol/teams").TeamInvitationPostAuthContinuationV1;
                }>;
            try {
                existingAccountWrite = await inTx(async (tx) => {
                    await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                    if (
                        isAccountDirectory
                        && (
                            parsedValue.securityBinding?.provider.source === "managed"
                            || !isAuthSignupProviderEnabled(requestHomeEnv, providerId)
                        )
                    ) {
                        return { status: "provider_disabled" as const };
                    }
                    if (!isAccountDirectory
                        && !isTeamOwnedConnectionAdmission(parsedValue.securityBinding)
                        && !await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                            env: requestHomeEnv,
                            methodId: providerId,
                            actionId: "provision",
                            mode: "keyed",
                        })) return { status: "provider_disabled" as const };
                    const invitationSource = isTeamAdmission
                        && parsedValue.securityBinding?.admission?.kind === "team_invitation"
                        ? parsedValue.securityBinding.admission
                        : null;
                    const claimedInvitation = invitationSource
                        ? await claimTeamInvitationPostAuthContinuationInTx(tx, {
                            reference: pending.key,
                            expectedValue: pending.value,
                            accountId: existingAccount.id,
                            invitation: invitationSource,
                        })
                        : null;
                    const consumed = invitationSource
                        ? claimedInvitation !== null
                        : await consumeValidOAuthPendingInTx(tx, pending);
                    if (!consumed) return { status: "invalid_pending" as const };

                    if (contentKeyBinding) {
                        const admission = await admitAccountContentKey(tx, {
                            accountId: existingAccount.id,
                            contentPublicKey: contentKeyBinding.contentPublicKey,
                            contentPublicKeySignature: contentKeyBinding.contentPublicKeySignature,
                        });
                        if (admission.status === "key_mismatch") {
                            throw new Error("content_public_key_mismatch");
                        }
                        if (
                            admission.status === "account_not_found"
                            || admission.status === "invalid_binding"
                        ) {
                            throw new Error("invalid_content_public_key_binding");
                        }
                    }

                    await tx.account.update({
                        where: { id: existingAccount.id },
                        data: {
                            updatedAt: new Date(),
                            ...(!existingAccount.username
                                ? { username: desiredUsername }
                                : {}),
                        },
                    });
                    await preparedIdentityConnection.connectInTx(tx);
                    if (isTeamAdmission && preparedIdentityConnection.verifiedMailbox) {
                        await upsertVerifiedMailboxEvidenceInTx(tx, {
                            accountId: existingAccount.id,
                            email: preparedIdentityConnection.verifiedMailbox,
                        });
                    }
                    const teamAdmission = isTeamAdmission
                        ? await requireTeamOAuthAdmissionInTx(tx, {
                            env: requestHomeEnv,
                            accountId: existingAccount.id,
                            provider: parsedValue.securityBinding?.provider,
                            connection: parsedValue.securityBinding?.connection,
                            admission: parsedValue.securityBinding?.admission,
                        })
                        : undefined;
                    if (claimedInvitation && !teamAdmission?.invitationRequired) {
                        if (!await discardClaimedTeamInvitationPostAuthContinuationInTx(tx, claimedInvitation)) {
                            return { status: "invalid_pending" as const };
                        }
                    }
                    if (isAccountDirectory && sameServiceBootstrapPreparation) {
                        await ensureSameServiceHomeEntryInTx(tx, {
                            accountId: existingAccount.id,
                            preparation: sameServiceBootstrapPreparation,
                        });
                    }
                    const authenticationEvidence = teamAdmission?.authenticationEvidence ?? (parsedValue.securityBinding?.provider
                        ? await readOAuthAuthenticationEvidenceInTx(tx, {
                            accountId: existingAccount.id,
                            providerId,
                            runtimeFingerprint: parsedValue.securityBinding.provider.runtimeFingerprint,
                            ...(parsedValue.securityBinding.provider.context.kind === "team" && parsedValue.securityBinding.connection?.id
                                ? { teamConnectionId: parsedValue.securityBinding.connection.id }
                                : {}),
                        })
                        : undefined);
                    if (parsedValue.securityBinding && !authenticationEvidence) throw new Error("invalid-pending");
                    const token = await auth.createTokenInTx(
                        tx,
                        existingAccount.id,
                        undefined,
                        {
                            kind: isAccountDirectory
                                ? "account_directory"
                                : "account",
                            authority: "present_user",
                            authenticationEvidence,
                        },
                    );
                    return {
                        status: "written" as const,
                        token,
                        ...(claimedInvitation && teamAdmission?.invitationRequired
                            ? { teamInvitationContinuation: claimedInvitation.continuation }
                            : {}),
                    };
                });
            } catch (error) {
                if (error instanceof Error && error.message === "content_public_key_mismatch") {
                    return reply.code(409).send({ error: "content_public_key_mismatch" });
                }
                if (error instanceof Error && error.message === "invalid_content_public_key_binding") {
                    return reply.code(400).send({ error: "invalid-signature" });
                }
                if (error instanceof Error && error.message === "not-eligible") {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                }
                throw error;
            }

            if (existingAccountWrite.status === "provider_disabled") {
                return reply.code(403).send({ error: "signup-provider-disabled" });
            }
            if (existingAccountWrite.status === "invalid_pending") {
                return reply.code(400).send({ error: "invalid-pending" });
            }
            return reply.send({
                success: true,
                token: existingAccountWrite.token,
                ...(existingAccountWrite.teamInvitationContinuation
                    ? { teamInvitationContinuation: existingAccountWrite.teamInvitationContinuation }
                    : {}),
            });
        }

        return reply.code(400).send({ error: "invalid-pending" });
    });
}

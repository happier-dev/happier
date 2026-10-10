import { createHash, randomUUID } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { prepareExternalIdentityConnection } from "@/app/auth/providers/identity";
import { auth } from "@/app/auth/auth";
import { isAuthSignupProviderEnabled } from "@/app/auth/authPolicy";
import {
    isEffectiveHomeAuthMethodActionEnabled,
    isEffectiveHomeAuthMethodActionEnabledInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { db } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import {
    consumeValidOAuthPendingInTx,
    loadValidOAuthPending,
    deleteOAuthPendingBestEffort,
} from "../connectRoutes.oauthPending";
import { authPendingSchema, hasInvalidOAuthSecurityBinding } from "./oauthExternalSchemas";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { shouldDenyPublicSignupProvisioningAction } from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import { provisionFreshAccountInTx } from "@/app/auth/provisionFreshAccountInTx";
import { inTx } from "@/storage/inTx";
import { isCurrentAccountDirectoryOAuthTarget } from "./accountDirectoryOAuthTarget";
import {
    AccountDirectoryRouteErrorResponseV1Schema,
    ExternalOAuthFinalizeAuthSuccessResponseSchema,
} from "@happier-dev/protocol";
import { oauthExternalFinalizeErrorHandler } from "./oauthExternalFinalizeErrorHandler";
import {
    isTeamOwnedConnectionAdmission,
    requireCurrentOAuthPendingRuntime,
    requireCurrentOAuthPendingRuntimeInTx,
} from "./oauthSecurityBinding";
import { requireTeamOAuthAdmissionInTx, TeamOAuthAdmissionAbort } from "@/app/teams/memberships/teamOAuthAdmission";
import { readOAuthAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";
import {
    ensureSameServiceHomeEntryInTx,
    prepareSameServiceHomeEntry,
} from "@/app/accountDirectory/accountDirectoryService";
import { upsertVerifiedMailboxEvidenceInTx } from "@/app/auth/verifiedMailboxEvidence";
import { PROVIDER_ALREADY_LINKED_ERROR } from "./oauthExternalErrors";
import {
    claimTeamInvitationPostAuthContinuationInTx,
    discardClaimedTeamInvitationPostAuthContinuationInTx,
} from "@/app/teams/invitations/postAuthContinuation";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function registerExternalAuthFinalizeKeylessRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/finalize-keyless", {
        errorHandler: oauthExternalFinalizeErrorHandler,
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({
                pending: z.string().min(1),
                proof: z.string().min(1),
                username: z.string().min(1).optional(),
            }),
            response: {
                200: ExternalOAuthFinalizeAuthSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-proof", "username-required", "invalid-username"]) }),
                403: z.union([AccountDirectoryRouteErrorResponseV1Schema, z.object({ error: z.enum([
                    "keyless-disabled",
                    "not-eligible",
                    "e2ee-required",
                    "keyed-authentication-required",
                    "signup-provider-disabled",
                    "team_authentication_required",
                ]) })]),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.union([AccountDirectoryRouteErrorResponseV1Schema, z.object({ error: z.enum(["restore-required", "username-taken", "auth_provider_configuration_changed"]) })]),
                503: z.object({ error: z.literal("team_authentication_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) {
            if (!await resolveOAuthRuntimeById(requestHomeEnv, providerId)) return reply.code(404).send({ error: "unsupported-provider" });
            return reply.code(400).send({ error: "invalid-pending" });
        }

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

        if (parsedValue.flow !== "auth" || parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(400).send({ error: "invalid-pending" });
        }
        const pendingVersion =
            (parsedValue as { v?: unknown }).v;
        const isAccountDirectoryPurpose =
            pendingVersion === 2
            && (parsedValue as { purpose?: unknown }).purpose
                === "account_directory";
        const isAccountDirectory =
            isAccountDirectoryPurpose
            && (parsedValue as { authMode?: unknown }).authMode
                === "keyless";
        const isTeamAdmission = parsedValue.securityBinding?.purpose === "team_admission";
        const homeAdmission = isTeamAdmission ? parsedValue.securityBinding?.admission ?? undefined : undefined;
        if (isAccountDirectoryPurpose && !isAccountDirectory) {
            return reply.code(400).send({ error: "invalid-pending" });
        }
        if (
            isAccountDirectory
            && !await isCurrentAccountDirectoryOAuthTarget(parsedValue)
        ) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }
        const pendingFormat =
            pendingVersion === 2
                ? ("v2" as const)
                : (parsedValue as any)?.authMode === "keyless"
                    ? ("legacy_keyless" as const)
                    : null;
        if (!pendingFormat) return reply.code(400).send({ error: "invalid-pending" });

        const keylessEnv = readAuthOauthKeylessFeatureEnv(requestHomeEnv);
        if (!isAccountDirectory && !isTeamAdmission) {
            const allowed = await isEffectiveHomeAuthMethodActionEnabled({
                env: requestHomeEnv,
                methodId: providerId,
                actionId: "login",
                mode: "keyless",
            });
            const availability =
                resolveKeylessAccountsAvailability(requestHomeEnv);
            if (!allowed) {
                if (
                    !availability.ok
                    && keylessEnv.enabled
                    && keylessEnv.providers.includes(providerId)
                ) {
                    await deleteOAuthPendingBestEffort(pendingKey);
                    return reply.code(403).send({
                        error: availability.reason === "e2ee-required"
                            ? "e2ee-required"
                            : "keyless-disabled",
                    });
                }
                return reply.code(403).send({ error: "keyless-disabled" });
            }

            if (!availability.ok) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply
                    .code(403)
                    .send({
                        error: availability.reason === "e2ee-required"
                            ? "e2ee-required"
                            : "keyless-disabled",
                    });
            }
        } else if (!isTeamAdmission && (
            parsedValue.securityBinding?.provider.source === "managed"
            || !isAuthSignupProviderEnabled(requestHomeEnv, providerId)
        )) {
            // Account Directory continuations are admitted by the signup
            // provider policy in both modes. Consume that same canonical
            // decision from current server policy here, so a provider disabled
            // after authorization start returns the keyed finalizer's typed
            // failure without consuming the pending continuation or minting a
            // restricted credential.
            return reply.code(403).send({ error: "signup-provider-disabled" });
        }

        const proof = request.body.proof.toString();
        const proofHash = sha256Hex(proof);
        if (!(parsedValue as any).proofHash || proofHash !== (parsedValue as any).proofHash) {
            return reply.code(400).send({ error: "invalid-proof" });
        }

        const bindingInput = {
            env: requestHomeEnv,
            providerId, pendingKey, binding: parsedValue.securityBinding,
            purpose: isAccountDirectory ? "account_directory" : (isTeamAdmission ? "team_admission" : null),
        } as const;
        const provider = await requireCurrentOAuthPendingRuntime(bindingInput);

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            const prefix = pendingFormat === "v2"
                ? "pending_v2"
                : "pending_keyless";
            // An identity-proof-only provider persists no token in the continuation.
            const accessTokenEnc: unknown = (parsedValue as any).accessTokenEnc;
            accessToken = typeof accessTokenEnc === "string" && accessTokenEnc
                ? decryptString(
                    ["auth", "external", providerId, prefix, pendingKey, "token"],
                    privacyKit.decodeBase64(accessTokenEnc),
                )
                : "";
            if (typeof (parsedValue as any).refreshTokenEnc === "string" && (parsedValue as any).refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64((parsedValue as any).refreshTokenEnc);
                refreshToken = decryptString(["auth", "external", providerId, prefix, pendingKey, "refresh"], refreshBytes);
            }

            const profileBytes = privacyKit.decodeBase64((parsedValue as any).profileEnc);
            const profileJson = decryptString(
                ["auth", "external", providerId, prefix, pendingKey, "profile"],
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

        const existingIdentity = await db.accountIdentity.findFirst({
            where: { provider: providerId, providerUserId },
            select: { accountId: true },
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
        const finalizeExistingIdentity = async (
            identity: Readonly<{ accountId: string }>,
        ) => {
            const existingAccount = await db.account.findUnique({
                where: { id: identity.accountId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            const currentness = existingAccount
                ? deriveAccountEncryptionCurrentnessFromRow(
                    existingAccount,
                )
                : null;
            const requiresRestore =
                currentness?.status === "inconsistent"
                || currentness?.currentness.encryptionMode
                    === "e2ee";
            if (requiresRestore && !isAccountDirectory) {
                await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                return reply.code(409).send({ error: "restore-required" });
            }
            let preparedIdentityConnection: Awaited<ReturnType<typeof prepareExternalIdentityConnection>>;
            try {
                preparedIdentityConnection = await prepareExternalIdentityConnection({
                    providerId,
                    reference: parsedValue.securityBinding?.provider,
                    ctx: Context.create(identity.accountId),
                    profile: pendingProfile,
                    accessToken,
                    refreshToken,
                });
            } catch (error) {
                if (error instanceof Error && error.message === "not-eligible") {
                    await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                    return reply.code(403).send({ error: "not-eligible" });
                }
                throw error;
            }
            const preparation = isAccountDirectory
                ? await prepareSameServiceHomeEntry({})
                : null;
            if (
                preparation?.status === "not_dual_role"
                && preparation.reason === "server_identity_mismatch"
            ) {
                throw new Error("Same-service Home descriptor identity mismatch");
            }
            const finalized = await inTx(async (tx) => {
                await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                if (!isAccountDirectory
                    && !isTeamOwnedConnectionAdmission(parsedValue.securityBinding)
                    && !await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                        env: requestHomeEnv,
                        methodId: providerId,
                        actionId: "login",
                        mode: "keyless",
                    })) return null;
                const invitationSource = isTeamAdmission
                    && parsedValue.securityBinding?.admission?.kind === "team_invitation"
                    ? parsedValue.securityBinding.admission
                    : null;
                const claimedInvitation = invitationSource
                    ? await claimTeamInvitationPostAuthContinuationInTx(tx, {
                        reference: pending.key,
                        expectedValue: pending.value,
                        accountId: identity.accountId,
                        invitation: invitationSource,
                    })
                    : null;
                const consumed = invitationSource
                    ? claimedInvitation !== null
                    : await consumeValidOAuthPendingInTx(tx, pending);
                if (!consumed) return null;
                await preparedIdentityConnection.connectInTx(tx);
                if (isTeamAdmission && preparedIdentityConnection.verifiedMailbox) {
                    await upsertVerifiedMailboxEvidenceInTx(tx, {
                        accountId: identity.accountId,
                        email: preparedIdentityConnection.verifiedMailbox,
                    });
                }
                const teamAdmission = isTeamAdmission
                    ? await requireTeamOAuthAdmissionInTx(tx, {
                        env: requestHomeEnv,
                        accountId: identity.accountId,
                        provider: parsedValue.securityBinding?.provider,
                        connection: parsedValue.securityBinding?.connection,
                        admission: parsedValue.securityBinding?.admission,
                    })
                    : undefined;
                if (claimedInvitation && !teamAdmission?.invitationRequired) {
                    if (!await discardClaimedTeamInvitationPostAuthContinuationInTx(tx, claimedInvitation)) return null;
                }
                if (preparation) {
                    await ensureSameServiceHomeEntryInTx(tx, {
                        accountId: identity.accountId,
                        preparation,
                    });
                }
                const authenticationEvidence = teamAdmission?.authenticationEvidence ?? (parsedValue.securityBinding?.provider
                    ? await readOAuthAuthenticationEvidenceInTx(tx, {
                        accountId: identity.accountId,
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
                    identity.accountId,
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
                    token,
                    ...(claimedInvitation && teamAdmission?.invitationRequired
                        ? { teamInvitationContinuation: claimedInvitation.continuation }
                        : {}),
                };
            });
            if (!finalized) {
                return reply.code(400).send({ error: "invalid-pending" });
            }
            return reply.send({ success: true, ...finalized });
        };
        if (existingIdentity) {
            return await finalizeExistingIdentity(existingIdentity);
        }

        if (isAccountDirectory) {
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
            return reply.code(403).send({
                error: "keyed-authentication-required",
            });
        }

        const blocked = !isTeamAdmission && shouldDenyPublicSignupProvisioningAction({
            env: requestHomeEnv,
            requestIp: request.ip,
            methodId: providerId,
            mode: "keyless",
        });
        if (blocked) {
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
            return reply.code(403).send({ error: "not-eligible" });
        }

        if (!isTeamAdmission && !keylessEnv.autoProvision) {
            return reply.code(403).send({ error: "not-eligible" });
        }

        const eligibility = resolveKeylessAutoProvisionEligibility(requestHomeEnv);
        if (!eligibility.ok) {
            return reply.code(403).send({ error: eligibility.error });
        }

        const usernameProvidedRaw = request.body.username?.toString().trim() || "";
        let desiredUsername: string | null = null;
        if (usernameProvidedRaw) {
            const validation = validateUsername(usernameProvidedRaw, requestHomeEnv);
            if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
            desiredUsername = validation.username;
        } else {
            const required = parsedValue.usernameRequired === true;
            if (required) return reply.code(400).send({ error: "username-required" });
            const suggested = parsedValue.suggestedUsername?.toString().trim() || "";
            if (suggested) {
                const validation = validateUsername(suggested, requestHomeEnv);
                if (validation.ok) desiredUsername = validation.username;
            }
        }

        if (desiredUsername) {
            const taken = await db.account.findFirst({ where: { username: desiredUsername }, select: { id: true } });
            if (taken) {
                return reply.code(409).send({ error: "username-taken" });
            }
        }

        const accountId = randomUUID();
        try {
            const identityConnection = await prepareExternalIdentityConnection({
                reference: parsedValue.securityBinding?.provider,
                providerId,
                ctx: Context.create(accountId),
                profile: pendingProfile,
                accessToken,
                refreshToken,
                preferredUsername: desiredUsername,
            });
            const account = await inTx(async (tx) => {
                await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                    env: requestHomeEnv,
                    methodId: providerId,
                    actionId: "provision",
                    mode: "keyless",
                    ...(homeAdmission ? { admission: homeAdmission } : {}),
                })) {
                    if (isTeamAdmission) {
                        throw new TeamOAuthAdmissionAbort("team_authentication_required");
                    }
                    throw new Error("not-eligible");
                }
                const currentKeyless = readAuthOauthKeylessFeatureEnv(requestHomeEnv);
                const currentEligibility = resolveKeylessAutoProvisionEligibility(requestHomeEnv);
                if (!currentEligibility.ok || (!isTeamAdmission && (
                    !currentKeyless.enabled || !currentKeyless.autoProvision
                    || !currentKeyless.providers.includes(providerId)
                    || shouldDenyPublicSignupProvisioningAction({
                        env: requestHomeEnv,
                        requestIp: request.ip,
                        methodId: providerId,
                        mode: "keyless",
                    })
                ))) {
                    throw new Error("not-eligible");
                }
                if (!await consumeValidOAuthPendingInTx(tx, pending)) return null;
                const account = await provisionFreshAccountInTx(tx, {
                    insertSemantics: { kind: "must_create", accountId },
                    publicKey: null,
                    encryptionMode: currentEligibility.encryptionMode,
                    username: desiredUsername,
                    identityConnection,
                    verifiedMailbox: identityConnection.verifiedMailbox,
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
                    kind: "account",
                    authority: "present_user",
                    authenticationEvidence,
                });
                return { token };
            });
            if (!account) return reply.code(400).send({ error: "invalid-pending" });
            return reply.send({ success: true, token: account.token });
        } catch (error) {
            if (error instanceof Error && error.message === "not-eligible") {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                const racedIdentity = await db.accountIdentity.findFirst({
                    where: { provider: providerId, providerUserId },
                    select: { accountId: true },
                });
                if (racedIdentity) {
                    // The losing fresh-provision path has no committed local
                    // effects. Only the exact persisted identity winner is
                    // allowed to continue through the canonical finalizer.
                    return await finalizeExistingIdentity(racedIdentity);
                }
            }
            throw error;
        }
    });
}

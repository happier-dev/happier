import { z } from "zod/mini";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { type Fastify } from "../../types";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { isEffectiveHomeAuthMethodActionEnabled } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { OAUTH_STATE_UNAVAILABLE_CODE } from "@/app/auth/oauthStateErrors";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { createExternalAuthorizeAttempt, createExternalAuthorizeUrl } from "./oauthExternal/createExternalAuthorizeUrl";
import { oauthExternalRateLimitAuthParamsPerIp } from "./oauthExternal/oauthExternalRateLimits";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternal/oauthExternalErrors";
import { registerExternalAuthFinalizeRoute } from "./oauthExternal/registerExternalAuthFinalizeRoute";
import { registerExternalAuthFinalizeKeylessRoute } from "./oauthExternal/registerExternalAuthFinalizeKeylessRoute";
import { registerExternalAuthTokenExchangeRoute } from "./oauthExternal/registerExternalAuthTokenExchangeRoute";
import { oauthAuthPendingSchema } from "./oauthExternal/oauthExternalSchemas";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "./connectRoutes.oauthPending";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { ExternalOAuthErrorResponseSchema, ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import {
    resolveDesktopOAuthReturnScheme,
    resolveOauthStateAttemptTtlMsFromEnv,
    resolveWebAppOAuthReturnUrlFromRequestHeaders,
} from "./oauthExternal/oauthExternalConfig";
import { db } from "@/storage/db";
import {
    isTrulyKeylessPlainAccountRow,
} from "@/app/encryption/accountEncryptionMode";
import {
    normalizeHttpUrl,
} from "@/app/serverUrls/effectiveServerUrls";
import {
    resolveCurrentAccountDirectoryOAuthTarget,
} from "./oauthExternal/accountDirectoryOAuthTarget";
import { isTeamMembershipAdmissionEnabled } from "@/app/teams/memberships/membershipService";
import {
    resolveTeamAdmissionStartBinding,
    type TeamAdmissionStartBinding,
} from "./oauthExternal/teamAdmissionStartBinding";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function connectAuthExternalRoutes(app: Fastify) {
    //
    // External provider signup (no existing account required)
    //

    app.get("/v1/auth/external/:provider/params", {
        preHandler: async (request, reply) => {
            if (["account_encryption_first_key", "account_password_enrollment"].includes(String(
                (request.query as { purpose?: unknown }).purpose ?? "",
            ))) {
                return await app.authenticate(request, reply);
            }
        },
        config: { rateLimit: oauthExternalRateLimitAuthParamsPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z
                .object({
                    publicKey: z.optional(z.string()),
                    mode: z.optional(z.enum(["keyed", "keyless"])),
                    proofHash: z.optional(z.string()),
                    purpose: z.optional(z
                        .enum([
                            "account_encryption_first_key",
                            "account_password_enrollment",
                            "account_directory",
                            "team_admission",
                        ])),
                    requestDigest: z.optional(z.union([
                        AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
                        PasswordCredentialMutationDigestV1Schema,
                    ])),
                    endpointUrl: z.optional(z.string()),
                    endpointServerIdentityId: z.optional(z.string()),
                    canonicalServerUrl: z.optional(z.string()),
                    teamId: z.optional(z.string()),
                    connectionId: z.optional(z.string()),
                    origin: z.optional(z.enum(["home", "team"])),
                    desktopCallbackScheme: z.optional(z.string()),
                }).check(z.refine((q) => {
                    if (q.purpose === "account_encryption_first_key" || q.purpose === "account_password_enrollment") {
                        return q.mode === "keyless"
                            && Boolean(q.proofHash)
                            && Boolean(q.requestDigest)
                            && !q.publicKey;
                    }
                    if (q.purpose === "team_admission") {
                        const keyed = q.mode !== "keyless" && (Boolean(q.publicKey) !== Boolean(q.proofHash));
                        const keyless = q.mode === "keyless" && Boolean(q.proofHash) && !q.publicKey;
                        return (keyed || keyless) && Boolean(q.teamId);
                    }
                    if (q.purpose === "account_directory") {
                        const isKeyless = q.mode === "keyless"
                            && Boolean(q.proofHash)
                            && !q.publicKey;
                        const isKeyed = q.mode === "keyed"
                            && Boolean(q.publicKey)
                            && !q.proofHash;
                        return (isKeyless || isKeyed)
                            && Boolean(q.endpointUrl)
                            && Boolean(q.endpointServerIdentityId)
                            && Boolean(q.canonicalServerUrl);
                    }
                    if (q.mode === "keyless") return Boolean(q.proofHash);
                    if (typeof q.proofHash === "string" && q.proofHash.trim()) return true;
                    return Boolean(q.publicKey);
                }, {
                    message: "Expected a valid external-auth challenge binding",
                })),
            response: {
                200: ExternalOAuthParamsResponseSchema,
                400: ExternalOAuthErrorResponseSchema,
                403: ExternalOAuthErrorResponseSchema,
                404: z.object({ error: z.literal("unsupported-provider") }),
                503: ExternalOAuthErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const teamAdmission = request.query.purpose === "team_admission";
        const teamId = teamAdmission ? String(request.query.teamId ?? "").trim() : "";
        const teamProviderOrigin = teamAdmission ? request.query.origin ?? "team" : null;
        const connectionId = teamAdmission ? String(request.query.connectionId ?? "").trim() : "";
        if (teamAdmission && !teamId) {
            return reply.code(400).send({ error: "invalid-team-admission" });
        }
        if (teamAdmission && !await isTeamMembershipAdmissionEnabled({ env: requestHomeEnv })) {
            return reply.code(403).send({ error: "invalid-team-admission" });
        }
        const resolved = await resolveOAuthRuntimeById(
            requestHomeEnv,
            providerId,
            teamAdmission && teamProviderOrigin === "team" ? { kind: "team", teamId } : undefined,
        );
        if (!resolved) return reply.code(404).send({ error: "unsupported-provider" });
        const { provider, reference } = resolved;
        let teamAdmissionBinding: TeamAdmissionStartBinding | null = null;
        if (teamAdmission) {
            teamAdmissionBinding = await resolveTeamAdmissionStartBinding({
                teamId,
                providerId,
                origin: teamProviderOrigin!,
                connectionId,
                invitationToken: typeof request.headers["x-happier-team-invitation"] === "string"
                    ? request.headers["x-happier-team-invitation"].trim()
                    : "",
            });
            if (!teamAdmissionBinding) {
                return reply.code(403).send({ error: "invalid-team-admission" });
            }
        }

        const isFirstKeyStepUp = request.query.purpose === "account_encryption_first_key"
            || request.query.purpose === "account_password_enrollment";
        const isAccountDirectory =
            request.query.purpose === "account_directory";
        if (isFirstKeyStepUp) {
            const proofHash = request.query.proofHash!
                .toString()
                .trim()
                .toLowerCase();
            const requestDigest = request.query.requestDigest!
                .toString()
                .trim();
            if (!/^[0-9a-f]{64}$/.test(proofHash)) {
                return reply.code(400).send({ error: "Invalid proof" });
            }
            const [account, identity] = await Promise.all([
                db.account.findUnique({
                    where: { id: request.userId },
                    select: {
                        publicKey: true,
                        encryptionMode: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                    },
                }),
                db.accountIdentity.findFirst({
                    where: {
                        accountId: request.userId,
                        provider: providerId,
                    },
                    select: { id: true },
                }),
            ]);
            if (
                !account
                || !isTrulyKeylessPlainAccountRow(
                    account,
                )
                || !identity
            ) {
                return reply
                    .code(403)
                    .send({ error: "step-up-not-eligible" });
            }
            try {
                const webAppOAuthReturnUrl =
                    resolveWebAppOAuthReturnUrlFromRequestHeaders({
                        env: requestHomeEnv,
                        providerId,
                        headers: request.headers as Record<string, unknown>,
                    });
                const url = await createExternalAuthorizeUrl({
                    flow: "auth",
                    env: requestHomeEnv,
                    providerId,
                    provider,
                    reference,
                    publicKeyHex: null,
                    proofHash,
                    purpose: request.query.purpose,
                    userId: request.userId,
                    requestDigest,
                    ...(webAppOAuthReturnUrl
                        ? { webAppOAuthReturnUrl }
                        : {}),
                });
                if (!url) {
                    return reply
                        .code(400)
                        .send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
                }
                return reply.send({ url });
            } catch (error) {
                if (
                    error instanceof Error
                    && error.message === OAUTH_NOT_CONFIGURED_ERROR
                ) {
                    return reply
                        .code(400)
                        .send({ error: OAUTH_NOT_CONFIGURED_ERROR });
                }
                throw error;
            }
        }

        let accountDirectoryTarget:
            | Readonly<{
                endpointUrl: string;
                endpointServerIdentityId: string;
                canonicalServerUrl: string;
                expiresAt: Date;
            }>
            | null = null;
        if (isAccountDirectory) {
            const requestedEndpointUrl = normalizeHttpUrl(
                request.query.endpointUrl ?? "",
            );
            const requestedServerIdentityId = String(
                request.query.endpointServerIdentityId ?? "",
            ).trim();
            const requestedCanonicalServerUrl = normalizeHttpUrl(
                request.query.canonicalServerUrl ?? "",
            );
            const currentTarget =
                await resolveCurrentAccountDirectoryOAuthTarget(requestHomeEnv);
            if (
                !requestedEndpointUrl
                || !currentTarget
                || requestedEndpointUrl !== currentTarget.endpointUrl
                || !requestedServerIdentityId
                || requestedServerIdentityId
                    !== currentTarget.endpointServerIdentityId
                || !requestedCanonicalServerUrl
                || requestedCanonicalServerUrl
                    !== currentTarget.canonicalServerUrl
            ) {
                return reply
                    .code(400)
                    .send({ error: "invalid-account-directory-target" });
            }
            accountDirectoryTarget = {
                endpointUrl: currentTarget.endpointUrl,
                endpointServerIdentityId:
                    currentTarget.endpointServerIdentityId,
                canonicalServerUrl: currentTarget.canonicalServerUrl,
                expiresAt: new Date(
                    Date.now()
                    + resolveOauthStateAttemptTtlMsFromEnv(requestHomeEnv),
                ),
            };
        }

        const mode = (request.query as any)?.mode === "keyless" ? "keyless" : "keyed";
        const policy = resolveAuthPolicyFromEnv(requestHomeEnv);
        const keyedAllowed = teamAdmission
            ? true
            : isAccountDirectory
            ? reference.source !== "managed" && policy.signupProviders.includes(providerId)
            : await isEffectiveHomeAuthMethodActionEnabled({
                env: requestHomeEnv,
                methodId: providerId,
                actionId: "provision",
                mode: "keyed",
            });
        let keylessAllowed = false;
        if (isAccountDirectory && !keyedAllowed) {
            return reply.code(403).send({ error: "signup-provider-disabled" });
        }
        if (mode === "keyless" && !isAccountDirectory && !teamAdmission) {
            keylessAllowed = await isEffectiveHomeAuthMethodActionEnabled({
                env: requestHomeEnv,
                methodId: providerId,
                actionId: "login",
                mode: "keyless",
            });
            if (!keylessAllowed) return reply.code(403).send({ error: "keyless-disabled" });
            const availability = resolveKeylessAccountsAvailability(requestHomeEnv);
            if (!availability.ok) {
                return reply.code(403).send({ error: availability.reason === "e2ee-required" ? "e2ee-required" : "keyless-disabled" });
            }
        } else {
            // Universal proofHash auth-start: allow if either keyed signup or keyless is allowed.
            const proofHashCandidate = String((request.query as any)?.proofHash ?? "").trim();
            if (proofHashCandidate) {
                keylessAllowed = await isEffectiveHomeAuthMethodActionEnabled({
                    env: requestHomeEnv,
                    methodId: providerId,
                    actionId: "login",
                    mode: "keyless",
                });
                if (!keyedAllowed && !keylessAllowed) {
                    return reply.code(403).send({ error: "signup-provider-disabled" });
                }
                if (keylessAllowed) {
                    const availability = resolveKeylessAccountsAvailability(requestHomeEnv);
                    if (!availability.ok && !keyedAllowed) {
                        return reply.code(403).send({ error: availability.reason === "e2ee-required" ? "e2ee-required" : "keyless-disabled" });
                    }
                }
            } else if (!keyedAllowed) {
                return reply.code(403).send({ error: "signup-provider-disabled" });
            }
        }

        let publicKeyHex: string | null = null;
        let proofHash: string | null = null;
        if (mode === "keyed") {
            const proofHashRaw = String((request.query as any)?.proofHash ?? "").trim().toLowerCase();
            if (proofHashRaw) {
                if (!/^[0-9a-f]{64}$/.test(proofHashRaw)) return reply.code(400).send({ error: "Invalid proof" });
                proofHash = proofHashRaw;
            } else {
                try {
                    const publicKeyBytes = privacyKit.decodeBase64((request.query as any).publicKey);
                    if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
                        return reply.code(400).send({ error: "Invalid public key" });
                    }
                    publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
                } catch {
                    return reply.code(400).send({ error: "Invalid public key" });
                }
            }
        } else {
            proofHash = String((request.query as any)?.proofHash ?? "").trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(proofHash)) return reply.code(400).send({ error: "Invalid proof" });
        }

        try {
            const desktopCallbackScheme = resolveDesktopOAuthReturnScheme(request.query.desktopCallbackScheme);
            const returnTarget = desktopCallbackScheme
                ? { desktopCallbackScheme }
                : {
                    webAppOAuthReturnUrl: resolveWebAppOAuthReturnUrlFromRequestHeaders({
                        env: requestHomeEnv, providerId, headers: request.headers,
                    }),
                };
            if (teamAdmission) {
                const attempt = await createExternalAuthorizeAttempt({
                    flow: "auth",
                    env: requestHomeEnv,
                    providerId,
                    provider,
                    reference,
                    publicKeyHex,
                    proofHash,
                    purpose: "team_admission",
                    ...(teamAdmissionBinding?.connection ? { connection: teamAdmissionBinding.connection } : {}),
                    admission: teamAdmissionBinding?.admission ?? null,
                    ...returnTarget,
                });
                if (!attempt) return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
                return reply.send({
                    url: attempt.url,
                    purpose: "team_admission" as const,
                    teamId,
                    admissionReference: attempt.attemptId,
                    ...(desktopCallbackScheme ? { desktopAttemptId: attempt.attemptId } : {}),
                });
            }
            const attempt = await createExternalAuthorizeAttempt({
                flow: "auth",
                env: requestHomeEnv,
                providerId,
                provider,
                reference,
                publicKeyHex,
                proofHash,
                ...(accountDirectoryTarget
                    ? {
                        purpose: "account_directory" as const,
                        endpointUrl: accountDirectoryTarget.endpointUrl,
                        endpointServerIdentityId:
                            accountDirectoryTarget.endpointServerIdentityId,
                        canonicalServerUrl:
                            accountDirectoryTarget.canonicalServerUrl,
                        attemptExpiresAt:
                            accountDirectoryTarget.expiresAt,
                    }
                    : {}),
                ...returnTarget,
            });
            if (!attempt) {
                return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
            }
            const start = {
                url: attempt.url,
                ...(desktopCallbackScheme ? { desktopAttemptId: attempt.attemptId } : {}),
            };
            return reply.send(accountDirectoryTarget
                ? {
                    ...start,
                    purpose: "account_directory" as const,
                    credentialTarget: "account_directory" as const,
                    endpointUrl: accountDirectoryTarget.endpointUrl,
                    endpointServerIdentityId:
                        accountDirectoryTarget.endpointServerIdentityId,
                    canonicalServerUrl:
                        accountDirectoryTarget.canonicalServerUrl,
                    expiresAt:
                        accountDirectoryTarget.expiresAt.toISOString(),
                }
                : start);
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

    registerExternalAuthFinalizeRoute(app);
    registerExternalAuthFinalizeKeylessRoute(app);
    registerExternalAuthTokenExchangeRoute(app);

    app.delete("/v1/auth/external/:provider/pending/:pending", {
        schema: {
            params: z.object({
                provider: z.string(),
                pending: z.string(),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        if (!await resolveOAuthRuntimeById(requestHomeEnv, providerId)) {
            return reply.code(404).send({ error: "unsupported-provider" });
        }

        const pendingKey = request.params.pending.toString().trim();
        if (!pendingKey) return reply.send({ success: true });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.send({ success: true });
        try {
            const parsed = oauthAuthPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) return reply.send({ success: true });
            if (parsed.data.provider.toString().trim().toLowerCase() !== providerId) return reply.send({ success: true });
        } catch {
            return reply.send({ success: true });
        }

        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });
}

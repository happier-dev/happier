import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { prepareExternalIdentityConnection } from "@/app/auth/providers/identity";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { db } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import {
    consumeValidOAuthPendingInTx,
    deleteOAuthPendingBestEffort,
    loadValidOAuthPending,
} from "../connectRoutes.oauthPending";
import { PROVIDER_ALREADY_LINKED_ERROR } from "./oauthExternalErrors";
import { connectPendingSchema, hasInvalidOAuthSecurityBinding } from "./oauthExternalSchemas";
import {
    isTeamOwnedConnectionAdmission,
    requireCurrentOAuthPendingRuntime,
    requireCurrentOAuthPendingRuntimeInTx,
} from "./oauthSecurityBinding";
import { oauthExternalFinalizeErrorHandler } from "./oauthExternalFinalizeErrorHandler";
import {
    ExternalOAuthFinalizeConnectRequestSchema,
    ExternalOAuthFinalizeConnectSuccessResponseSchema,
} from "@happier-dev/protocol";
import { inTx } from "@/storage/inTx";
import { isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import {
    AuthenticationEvidenceLimitError,
    mergeCurrentAuthenticationEvidenceInTx,
    readOAuthAuthenticationEvidenceInTx,
} from "@/app/auth/authenticationEvidence";
import { auth } from "@/app/auth/auth";
import { requireTeamOAuthAdmissionInTx } from "@/app/teams/memberships/teamOAuthAdmission";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "../../../utils/requirePresentUser";

export function registerExternalConnectFinalizeRoute(app: Fastify) {
    app.post("/v1/connect/external/:provider/finalize", {
        errorHandler: oauthExternalFinalizeErrorHandler,
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ provider: z.string() }),
            body: ExternalOAuthFinalizeConnectRequestSchema,
            response: {
                200: ExternalOAuthFinalizeConnectSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-username"]) }),
                // A Team-admission connect is refused by `oauthExternalFinalizeErrorHandler`
                // with the same typed Team outcome the authentication finalizers declare.
                403: z.union([
                    PresentUserRequiredResponseSchema,
                    z.object({ error: z.enum(["forbidden", "not-eligible", "team_authentication_required"]) }),
                ]),
                503: z.object({ error: z.literal("team_authentication_unavailable") }),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.union([
                    z.object({ error: z.literal("auth_provider_configuration_changed") }),
                    z.object({ error: z.literal("username-taken") }),
                    z.object({ error: z.literal("credential_authentication_evidence_limit") }),
                    z.object({ error: z.literal(PROVIDER_ALREADY_LINKED_ERROR), provider: z.string() }),
                ]),
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

        let parsedValue: z.infer<typeof connectPendingSchema>;
        try {
            const value: unknown = JSON.parse(pending.value);
            const parsed = connectPendingSchema.safeParse(value);
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

        if (parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (parsedValue.userId !== request.userId) {
            return reply.code(403).send({ error: "forbidden" });
        }

        const bindingInput = {
            env: requestHomeEnv,
            providerId,
            pendingKey,
            binding: parsedValue.securityBinding,
            purpose: parsedValue.securityBinding?.purpose ?? null,
        } as const;
        const isTeamAdmission = parsedValue.securityBinding?.purpose === "team_admission";
        await requireCurrentOAuthPendingRuntime(bindingInput);

        const validation = validateUsername(request.body.username, requestHomeEnv);
        if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
        const username = validation.username;

        const taken = await db.account.findFirst({
            where: {
                username,
                NOT: { id: request.userId },
            },
            select: { id: true },
        });
        if (taken) return reply.code(409).send({ error: "username-taken" });

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            // An identity-proof-only provider persists no token in the continuation.
            accessToken = parsedValue.accessTokenEnc
                ? decryptString(
                    ["user", request.userId, "connect", providerId, "pending", pendingKey],
                    privacyKit.decodeBase64(parsedValue.accessTokenEnc),
                )
                : "";
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(
                    ["user", request.userId, "connect", providerId, "pending", pendingKey, "refresh"],
                    refreshBytes,
                );
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                ["user", request.userId, "connect", providerId, "pending", pendingKey, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const ctx = Context.create(request.userId);
        try {
            const prepared = await prepareExternalIdentityConnection({
                reference: parsedValue.securityBinding?.provider,
                providerId,
                ctx,
                profile: pendingProfile,
                accessToken,
                refreshToken,
                preferredUsername: username,
            });
            const token = await inTx(async (tx) => {
                await requireCurrentOAuthPendingRuntimeInTx(tx, bindingInput);
                if (!isTeamOwnedConnectionAdmission(parsedValue.securityBinding)
                    && !await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                        env: requestHomeEnv,
                        methodId: providerId,
                        actionId: "connect",
                    })) return false;
                if (!await consumeValidOAuthPendingInTx(tx, pending)) return null;
                await prepared.connectInTx(tx);
                const teamAuthenticationEvidence = isTeamAdmission
                    ? await requireTeamOAuthAdmissionInTx(tx, {
                        env: requestHomeEnv,
                        accountId: request.userId,
                        provider: parsedValue.securityBinding?.provider,
                        connection: parsedValue.securityBinding?.connection,
                        admission: parsedValue.securityBinding?.admission,
                    })
                    : undefined;
                const newlyVerified = teamAuthenticationEvidence?.authenticationEvidence ?? (parsedValue.securityBinding
                    ? await readOAuthAuthenticationEvidenceInTx(tx, {
                        accountId: request.userId,
                        providerId,
                        runtimeFingerprint: parsedValue.securityBinding.provider.runtimeFingerprint,
                        ...(parsedValue.securityBinding.provider.context.kind === "team" && parsedValue.securityBinding.connection?.id
                            ? { teamConnectionId: parsedValue.securityBinding.connection.id }
                            : {}),
                    })
                    : undefined);
                const authenticationEvidence = await mergeCurrentAuthenticationEvidenceInTx(tx, {
                    env: requestHomeEnv,
                    accountId: request.userId,
                    initiating: request.authTokenAuthenticationEvidence,
                    newlyVerified,
                });
                return await auth.createTokenInTx(tx, request.userId, undefined, {
                    kind: "account",
                    authority: "present_user",
                    ...(authenticationEvidence.length > 0 ? { authenticationEvidence } : {}),
                });
            });
            if (!token) {
                return reply.code(400).send({ error: "invalid-pending" });
            }
            return reply.send({ success: true, token });
        } catch (error) {
            if (error instanceof Error && error.message === "invalid-pending") {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-pending" });
            }
            if (error instanceof Error && error.message === "not-eligible") {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
            if (error instanceof AuthenticationEvidenceLimitError) {
                return reply.code(409).send({ error: error.code });
            }
            throw error;
        }

        throw new Error("External connection finalization completed without publishing its replacement credential");
    });
}

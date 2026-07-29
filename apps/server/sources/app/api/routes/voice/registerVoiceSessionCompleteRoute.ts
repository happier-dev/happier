import { z } from "zod";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { createHostedElevenLabsService } from "@/voice/providers/elevenLabs";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { elevenLabsAgentsVoiceProviderId } from "./voiceProviderIds";
import { createVoiceRouteAbortScope } from "./voiceRouteAbortScope";
import { type VoiceSessionLifecycleBody, voiceSessionLifecycleBodySchema } from "./voiceSessionLifecycleSchemas";
import {
    VoiceProviderConversationIdentityCollisionError,
    assertVoiceProviderConversationIdentityExactMatch,
    createVoiceProviderConversationIdentity,
} from "./voiceProviderConversationIdentity";
import { type Fastify } from "../../types";

class VoiceCompletionConflictError extends Error {
    constructor() {
        super("voice_completion_conflict");
        this.name = "VoiceCompletionConflictError";
    }
}

export function registerVoiceSessionCompleteRoute(app: Fastify): void {
    app.post('/v1/voice/session/complete', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: voiceSessionLifecycleBodySchema,
            response: {
                200: z.object({
                    ok: z.literal(true),
                    durationSeconds: z.number().int().min(0),
                }),
                404: z.object({
                    ok: z.literal(false),
                    reason: z.literal("not_found"),
                }),
                503: z.object({
                    ok: z.literal(false),
                    reason: z.literal("upstream_error"),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { leaseId, providerConversationId } = request.body as VoiceSessionLifecycleBody;
        const providerIdentity = createVoiceProviderConversationIdentity({
            providerId: elevenLabsAgentsVoiceProviderId,
            providerConversationId,
        });

        const serverFeatures = resolveServerFeaturesForGating(process.env);
        if (!isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice")) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const lease = await db.voiceSessionLease.findFirst({
            where: {
                id: leaseId,
                accountId: userId,
            },
            select: {
                id: true,
                accountId: true,
                elevenLabsAgentId: true,
                grantedBy: true,
                periodKey: true,
                providerBindingNonce: true,
                createdAt: true,
                expiresAt: true,
            },
        });
        if (!lease) {
            // Fail closed without leaking whether the lease exists for other users.
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }
        if (!lease.providerBindingNonce) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        // A completed row is already provider-attested durable truth. Retry it from storage so a
        // lost response does not become an upstream failure if the provider is later unavailable.
        // Legacy null-key rows still continue through verification so this request upgrades them.
        try {
            const completedForLease = await db.voiceConversation.findUnique({
                where: { leaseId: lease.id },
                select: {
                    accountId: true,
                    providerId: true,
                    providerConversationId: true,
                    providerConversationKey: true,
                    durationSeconds: true,
                    grantedBy: true,
                    grantPeriodKey: true,
                },
            });
            if (
                completedForLease?.providerConversationKey === providerIdentity.providerConversationKey &&
                completedForLease.grantedBy !== null &&
                completedForLease.grantPeriodKey !== null
            ) {
                assertVoiceProviderConversationIdentityExactMatch({
                    expected: providerIdentity,
                    stored: {
                        providerId: completedForLease.providerId,
                        providerConversationId: completedForLease.providerConversationId,
                        providerConversationKey: completedForLease.providerConversationKey,
                    },
                });
                if (
                    completedForLease.accountId !== lease.accountId ||
                    completedForLease.grantedBy !== lease.grantedBy ||
                    completedForLease.grantPeriodKey !== lease.periodKey
                ) {
                    return reply.code(404).send({ ok: false, reason: "not_found" as const });
                }
                return reply.send({ ok: true, durationSeconds: completedForLease.durationSeconds });
            }
            if (
                completedForLease &&
                (completedForLease.providerId !== providerIdentity.providerId ||
                    completedForLease.providerConversationId !== providerIdentity.providerConversationId)
            ) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
        } catch (e) {
            if (e instanceof VoiceProviderConversationIdentityCollisionError) {
                log({ module: "voice" }, "Voice provider conversation identity collision");
            }
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        const elevenLabsService = createHostedElevenLabsService(process.env);
        const providerAbortScope = createVoiceRouteAbortScope(reply);
        const verification = await elevenLabsService
            .verifyConversation({
                providerConversationId,
                expectedAgentId: lease.elevenLabsAgentId,
                expectedBindingNonce: lease.providerBindingNonce,
                leaseCreatedAt: lease.createdAt,
                leaseExpiresAt: lease.expiresAt,
                signal: providerAbortScope.signal,
            })
            .finally(() => providerAbortScope.dispose());
        if (!verification.ok) {
            log(
                { module: "voice", provider: "elevenlabs", diagnosticCode: verification.diagnosticCode },
                "Hosted voice conversation verification failed",
            );
            return verification.reason === "not_found"
                ? reply.code(404).send({ ok: false, reason: "not_found" as const })
                : reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }
        let durationSeconds = verification.durationSeconds;
        const startedAt = verification.startedAt;
        const endedAt = verification.endedAt;

        try {
            const result = await inTx(async (tx) => {
                // All rejection/conflict reads must finish before the first mutation. Returning a
                // rejection after a write would commit that write in an interactive transaction.
                const currentLease = await tx.voiceSessionLease.findFirst({
                    where: {
                        id: lease.id,
                        accountId: lease.accountId,
                    },
                    select: {
                        id: true,
                        accountId: true,
                        elevenLabsAgentId: true,
                        grantedBy: true,
                        periodKey: true,
                        providerBindingNonce: true,
                    },
                });

                const existingForConversationByKey = await tx.voiceConversation.findUnique({
                    where: {
                        providerId_providerConversationKey: {
                            providerId: providerIdentity.providerId,
                            providerConversationKey: providerIdentity.providerConversationKey,
                        },
                    },
                    select: {
                        id: true,
                        accountId: true,
                        leaseId: true,
                        providerId: true,
                        providerConversationId: true,
                        providerConversationKey: true,
                        durationSeconds: true,
                        grantedBy: true,
                        grantPeriodKey: true,
                    },
                });
                if (existingForConversationByKey) {
                    assertVoiceProviderConversationIdentityExactMatch({
                        expected: providerIdentity,
                        stored: {
                            providerId: existingForConversationByKey.providerId,
                            providerConversationId: existingForConversationByKey.providerConversationId,
                            providerConversationKey: existingForConversationByKey.providerConversationKey ?? "",
                        },
                    });
                }

                // During the rolling migration, old rows can have a null digest. The exact-value
                // fallback is read-only compatibility and disappears after the backfill gate.
                const legacyExistingForConversation = existingForConversationByKey
                    ? null
                    : await tx.voiceConversation.findFirst({
                          where: {
                              providerId: providerIdentity.providerId,
                              providerConversationId: providerIdentity.providerConversationId,
                              providerConversationKey: null,
                          },
                          select: {
                              id: true,
                              accountId: true,
                              leaseId: true,
                              providerId: true,
                              providerConversationId: true,
                              providerConversationKey: true,
                              durationSeconds: true,
                              grantedBy: true,
                              grantPeriodKey: true,
                          },
                      });
                const existingForConversation = existingForConversationByKey ?? legacyExistingForConversation;

                const existingForLease = await tx.voiceConversation.findUnique({
                    where: { leaseId: lease.id },
                    select: {
                        accountId: true,
                        providerId: true,
                        providerConversationId: true,
                        providerConversationKey: true,
                        grantedBy: true,
                        grantPeriodKey: true,
                    },
                });

                if (
                    !currentLease ||
                    currentLease.providerBindingNonce !== lease.providerBindingNonce ||
                    currentLease.elevenLabsAgentId !== lease.elevenLabsAgentId
                ) {
                    return "not_found" as const;
                }
                if (
                    existingForConversation &&
                    (existingForConversation.accountId !== lease.accountId ||
                        existingForConversation.leaseId !== lease.id ||
                        existingForConversation.providerId !== providerIdentity.providerId ||
                        existingForConversation.providerConversationId !== providerIdentity.providerConversationId ||
                        (existingForConversation.grantedBy !== null &&
                            existingForConversation.grantedBy !== currentLease.grantedBy) ||
                        (existingForConversation.grantPeriodKey !== null &&
                            existingForConversation.grantPeriodKey !== currentLease.periodKey) ||
                        (existingForConversation.providerConversationKey !== null &&
                            existingForConversation.providerConversationKey !== providerIdentity.providerConversationKey))
                ) {
                    return "not_found" as const;
                }
                if (
                    existingForLease &&
                    (existingForLease.accountId !== lease.accountId ||
                        existingForLease.providerId !== providerIdentity.providerId ||
                        existingForLease.providerConversationId !== providerIdentity.providerConversationId ||
                        (existingForLease.grantedBy !== null &&
                            existingForLease.grantedBy !== currentLease.grantedBy) ||
                        (existingForLease.grantPeriodKey !== null &&
                            existingForLease.grantPeriodKey !== currentLease.periodKey) ||
                        (existingForLease.providerConversationKey !== null &&
                            existingForLease.providerConversationKey !== providerIdentity.providerConversationKey))
                ) {
                    return "not_found" as const;
                }

                const bindLease = await tx.voiceSessionLease.updateMany({
                    where: {
                        id: currentLease.id,
                        accountId: currentLease.accountId,
                        elevenLabsAgentId: currentLease.elevenLabsAgentId,
                        providerBindingNonce: currentLease.providerBindingNonce,
                    },
                    data: {
                        providerId: providerIdentity.providerId,
                        providerConversationId: providerIdentity.providerConversationId,
                        providerConversationKey: providerIdentity.providerConversationKey,
                    },
                });
                if (bindLease.count !== 1) {
                    throw new VoiceCompletionConflictError();
                }

                if (existingForConversation?.providerConversationKey === null) {
                    const upgradeLegacyConversation = await tx.voiceConversation.updateMany({
                        where: {
                            id: existingForConversation.id,
                            providerId: providerIdentity.providerId,
                            providerConversationId: providerIdentity.providerConversationId,
                            providerConversationKey: null,
                        },
                        data: {
                            providerConversationKey: providerIdentity.providerConversationKey,
                            grantedBy: currentLease.grantedBy,
                            grantPeriodKey: currentLease.periodKey,
                        },
                    });
                    if (upgradeLegacyConversation.count !== 1) {
                        throw new VoiceCompletionConflictError();
                    }
                } else if (
                    existingForConversation &&
                    (existingForConversation.grantedBy === null ||
                        existingForConversation.grantPeriodKey === null)
                ) {
                    const upgradeLegacyGrant = await tx.voiceConversation.updateMany({
                        where: {
                            id: existingForConversation.id,
                            OR: [
                                { grantedBy: null },
                                { grantPeriodKey: null },
                            ],
                        },
                        data: {
                            grantedBy: existingForConversation.grantedBy ?? currentLease.grantedBy,
                            grantPeriodKey: existingForConversation.grantPeriodKey ?? currentLease.periodKey,
                        },
                    });
                    if (upgradeLegacyGrant.count !== 1) {
                        throw new VoiceCompletionConflictError();
                    }
                } else if (!existingForConversation) {
                    await tx.voiceConversation.create({
                        data: {
                            accountId: lease.accountId,
                            leaseId: lease.id,
                            providerId: providerIdentity.providerId,
                            providerConversationId: providerIdentity.providerConversationId,
                            providerConversationKey: providerIdentity.providerConversationKey,
                            startedAt,
                            endedAt,
                            durationSeconds,
                            billedUnits: null,
                            grantedBy: currentLease.grantedBy,
                            grantPeriodKey: currentLease.periodKey,
                        },
                    });
                }
                return {
                    kind: "completed" as const,
                    durationSeconds: existingForConversation?.durationSeconds ?? durationSeconds,
                };
            });
            if (result === "not_found") {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
            durationSeconds = result.durationSeconds;
        } catch (e) {
            if (e instanceof VoiceProviderConversationIdentityCollisionError) {
                log({ module: "voice" }, "Voice provider conversation identity collision");
                return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
            }
            if (e instanceof VoiceCompletionConflictError || isPrismaErrorCode(e, "P2002")) {
                const winner = await db.voiceConversation.findUnique({
                    where: {
                        providerId_providerConversationKey: {
                            providerId: providerIdentity.providerId,
                            providerConversationKey: providerIdentity.providerConversationKey,
                        },
                    },
                    select: {
                        accountId: true,
                        leaseId: true,
                        providerId: true,
                        providerConversationId: true,
                        providerConversationKey: true,
                        durationSeconds: true,
                    },
                }).catch(() => null);
                if (
                    winner &&
                    winner.accountId === lease.accountId &&
                    winner.leaseId === lease.id &&
                    winner.providerId === providerIdentity.providerId &&
                    winner.providerConversationId === providerIdentity.providerConversationId &&
                    winner.providerConversationKey === providerIdentity.providerConversationKey
                ) {
                    return reply.send({ ok: true, durationSeconds: winner.durationSeconds });
                }
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
            log({ module: "voice" }, "Failed to persist voice conversation");
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        return reply.send({ ok: true, durationSeconds });
    });
}

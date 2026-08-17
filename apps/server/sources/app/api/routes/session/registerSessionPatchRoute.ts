import { z } from "zod";
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionMetadataActiveConflictV1Schema,
    SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
    SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
    SessionMetadataInactiveModelIntentPatchV1Schema,
    SessionMetadataInactiveModelIntentVersionConflictV1Schema,
    SessionMetadataTuplePatchSuccessV1Schema,
    SessionMetadataTuplePatchV1Schema,
    SessionMetadataVersionConflictV1Schema,
} from "@happier-dev/protocol";

import {
    patchSession,
    updateSessionMetadataEnvelopeTuple,
} from "@/app/session/sessionWriteService";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { publishSessionCurrentViewUpdates } from "@/app/session/metadata/publishSessionCurrentViewUpdates";
import { db } from "@/storage/db";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { type Fastify } from "../../types";

export function registerSessionPatchRoute(app: Fastify) {
    const legacyPatchBodySchema = z.object({
        metadata: z.object({
            ciphertext: z.string(),
            expectedVersion: z.number().int().min(0),
        }).strict().optional(),
        agentState: z.object({
            ciphertext: z.string().nullable(),
            expectedVersion: z.number().int().min(0),
        }).strict().optional(),
    }).strict();
    app.patch('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.union([
                SessionMetadataTuplePatchV1Schema,
                SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
                SessionMetadataInactiveModelIntentPatchV1Schema,
                legacyPatchBodySchema,
            ]),
            response: {
                200: z.union([
                    SessionMetadataTuplePatchSuccessV1Schema,
                    SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
                    SessionMetadataInactiveModelIntentVersionConflictV1Schema,
                    z.object({
                        success: z.literal(true),
                        metadata: z.object({ version: z.number() }).optional(),
                        agentState: z.object({ version: z.number() }).optional(),
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal("version-mismatch"),
                        metadataLayoutVersion: z.number().int().nonnegative().optional(),
                        metadata: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                        agentState: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                    }),
                ]),
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.union([
                    z.object({
                        error: z.literal("Session metadata privacy upgrade required"),
                        code: z.literal("metadata_privacy_upgrade_required"),
                    }),
                    SessionMetadataVersionConflictV1Schema,
                    SessionMetadataActiveConflictV1Schema,
                    z.object({
                        code: z.literal(
                            "session_publisher_authority_lost",
                        ),
                    }).strict(),
                ]),
                426: z.unknown(),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        if ("mode" in request.body) {
            const tupleBody = request.body;
            if (
                !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }
            const tupleResult = await updateSessionMetadataEnvelopeTuple({
                ...tupleBody,
                actorUserId: userId,
                sessionId,
            });
            if (!tupleResult.ok) {
                if (tupleResult.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
                if (tupleResult.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
                if (tupleResult.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
                if (tupleResult.error === "session_active") {
                    return reply.code(409).send({
                        code: "session_active" as const,
                    });
                }
                if (tupleResult.error === "publisher-superseded") {
                    return reply.code(409).send({
                        code:
                            "session_publisher_authority_lost" as const,
                    });
                }
                if (tupleResult.error === "metadata_privacy_upgrade_required") {
                    return reply.code(409).send(
                        createSessionMetadataPrivacyUpgradeRequiredResponse(),
                    );
                }
                if (tupleResult.error === "version-mismatch") {
                    if (!tupleResult.current) {
                        return reply.code(500).send({ error: "Failed to update session" });
                    }
                    if (
                        tupleResult.current.metadataLayoutVersion
                        !== SESSION_METADATA_LAYOUT_VERSION_V1
                    ) {
                        return reply.code(409).send(
                            createSessionMetadataPrivacyUpgradeRequiredResponse(),
                        );
                    }
                    return reply.code(409).send({
                        code: "session_metadata_version_conflict" as const,
                        metadataLayoutVersion:
                            SESSION_METADATA_LAYOUT_VERSION_V1,
                        sharedMetadata: {
                            version: tupleResult.current.sharedMetadata.version,
                        },
                        ...(tupleResult.current.agentState
                            ? {
                                agentState: {
                                    version: tupleResult.current.agentState.version,
                                },
                            }
                            : {}),
                    });
                }
                return reply.code(500).send({ error: "Failed to update session" });
            }

            const published = await publishSessionCurrentViewUpdates({
                sessionId,
                participantCursors: tupleResult.participantCursors,
                source: {
                    kind: "envelope_tuple_v1",
                    sessionOwnerId: tupleResult.sessionOwnerId,
                    ownerAccountMode: tupleResult.ownerAccountMode,
                    sharedMetadata: tupleResult.sharedMetadata,
                    ownerMetadata: tupleResult.ownerMetadata,
                    agentState: tupleResult.agentState,
                },
            });
            if (!published.ok) {
                return reply.code(500).send({
                    error: "Failed to update session",
                });
            }

            return reply.send({
                success: true as const,
                metadataLayoutVersion: tupleResult.metadataLayoutVersion,
                sharedMetadata: { version: tupleResult.sharedMetadata.version },
                ...(tupleBody.mode !== "shared_editor"
                    ? { agentState: { version: tupleResult.agentState.version } }
                    : {}),
            });
        }

        const conditionedMutation = "inactiveModelIntent" in request.body
            ? request.body.inactiveModelIntent
            : null;
        const metadata = conditionedMutation?.metadata
            ?? (
                "metadata" in request.body
                    ? request.body.metadata
                    : undefined
            );
        const agentState = "agentState" in request.body
            ? request.body.agentState
            : undefined;
        const sessionExpectation =
            conditionedMutation?.sessionExpectation;

        const result = await patchSession({
            actorUserId: userId,
            sessionId,
            metadata: metadata ? { ciphertext: metadata.ciphertext, expectedVersion: metadata.expectedVersion } : undefined,
            agentState: agentState ? { ciphertext: agentState.ciphertext, expectedVersion: agentState.expectedVersion } : undefined,
            sessionExpectation,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            if (result.error === "session_active") {
                return reply.code(409).send({
                    code: "session_active" as const,
                });
            }
            if (result.error === "metadata_privacy_upgrade_required") {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            if (result.error === "version-mismatch") {
                if (!result.current) {
                    return reply.code(500).send({ error: "Failed to update session" });
                }
                if (conditionedMutation) {
                    if (!result.current.metadata) {
                        return reply.code(500).send({
                            error: "Failed to update session",
                        });
                    }
                    return reply.send(
                        SessionMetadataInactiveModelIntentVersionConflictV1Schema
                            .parse({
                                success: false as const,
                                error: "version-mismatch" as const,
                                metadata: result.current.metadata,
                            }),
                    );
                }
                return reply.send({
                    success: false as const,
                    error: "version-mismatch" as const,
                    ...(result.current?.metadata ? { metadata: result.current.metadata } : {}),
                    ...(result.current?.agentState ? { agentState: result.current.agentState } : {}),
                });
            }
            return reply.code(500).send({ error: "Failed to update session" });
        }

        const currentSession = await db.session.findUnique({
            where: { id: sessionId },
            select: {
                accountId: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        });
        if (!currentSession) {
            return reply.code(404).send({
                error: "Session not found",
            });
        }
        const publishedLegacy = await publishSessionCurrentViewUpdates({
            sessionId,
            participantCursors: result.participantCursors,
            source: {
                kind: "legacy_v0",
                sessionOwnerId: userId,
                session: currentSession,
            },
        });
        if (!publishedLegacy.ok) {
            return reply.code(500).send({ error: "Failed to update session" });
        }

        if (conditionedMutation) {
            if (!result.metadata) {
                return reply.code(500).send({
                    error: "Failed to update session",
                });
            }
            return reply.send(
                SessionMetadataInactiveModelIntentPatchSuccessV1Schema.parse({
                    success: true as const,
                    metadata: { version: result.metadata.version },
                }),
            );
        }
        return reply.send({
            success: true as const,
            ...(result.metadata ? { metadata: { version: result.metadata.version } } : {}),
            ...(result.agentState ? { agentState: { version: result.agentState.version } } : {}),
        });
    });
}

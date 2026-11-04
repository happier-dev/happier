import { z } from "zod/mini";
import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionMetadataActiveConflictV1Schema, SessionMetadataInactiveModelIntentOwnerPatchV1Schema, SessionMetadataInactiveModelIntentPatchSuccessV1Schema, SessionMetadataInactiveModelIntentPatchV1Schema, SessionMetadataInactiveModelIntentVersionConflictV1Schema, SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

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
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { SessionTeamCredentialBindingMetadataPatchV1Schema, SessionTeamCredentialBindingMutationRejectionV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { log } from "@/utils/logging/log";

export function registerSessionPatchRoute(app: Fastify) {
    const legacyPatchBodySchema = z.strictObject({
        metadata: z.optional(z.strictObject({
            ciphertext: z.string(),
            expectedVersion: z.number().check(z.int(), z.minimum(0)),
        })),
        agentState: z.optional(z.strictObject({
            ciphertext: z.nullable(z.string()),
            expectedVersion: z.number().check(z.int(), z.minimum(0)),
        })),
    });
    app.patch('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        attachValidation: true,
        config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.union([
                SessionMetadataTuplePatchV1Schema,
                SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
                SessionMetadataInactiveModelIntentPatchV1Schema,
                SessionTeamCredentialBindingMetadataPatchV1Schema,
                legacyPatchBodySchema,
            ]),
            response: {
                200: z.union([
                    SessionMetadataTuplePatchSuccessV1Schema,
                    SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
                    SessionMetadataInactiveModelIntentVersionConflictV1Schema,
                    z.object({
                        success: z.literal(true),
                        metadata: z.optional(z.object({ version: z.number() })),
                        agentState: z.optional(z.object({ version: z.number() })),
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal("version-mismatch"),
                        metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
                        metadata: z.optional(z.object({ version: z.number(), value: z.nullable(z.string()) })),
                        agentState: z.optional(z.object({ version: z.number(), value: z.nullable(z.string()) })),
                    }),
                ]),
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.union([
                    z.object({ error: z.literal("Forbidden") }),
                    z.object({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.object({ error: z.literal("session_access_authentication_required") }),
                ]),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.union([
                    z.object({
                        error: z.literal("Session metadata privacy upgrade required"),
                        code: z.literal("metadata_privacy_upgrade_required"),
                    }),
                    SessionMetadataVersionConflictV1Schema,
                    SessionMetadataActiveConflictV1Schema,
                    z.strictObject({
                        code: z.literal(
                            "session_publisher_authority_lost",
                        ),
                    }),
                    SessionTeamCredentialBindingMutationRejectionV1Schema,
                ]),
                426: z.unknown(),
                503: z.object({ error: z.literal("session_access_authentication_unavailable") }),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return reply.code(400).send({ error: "Invalid parameters" });
        }
        // A restricted Runner credential is issued for its own Session's shared
        // editor tuple. The owner metadata modes this endpoint also carries —
        // model intent and Team credential binding — remain present-user writes,
        // so the Runner is refused here rather than at the credential boundary,
        // which knows only the Session this request names.
        if (
            request.authTokenKind === "ephemeral_session_runner"
            && !("mode" in request.body && request.body.mode === "shared_editor")
        ) {
            return reply.code(403).send({ error: "Forbidden" });
        }
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
            const tupleInput = tupleBody.mode === "shared_editor"
                || tupleBody.mode === "owner_team_credential_binding"
                ? {
                    ...tupleBody,
                    actorUserId: userId,
                    sessionId,
                    authentication: readSessionAccessAuthenticationFromRequest(request),
                }
                : { ...tupleBody, actorUserId: userId, sessionId };
            const tupleResult = await updateSessionMetadataEnvelopeTuple(tupleInput);
            if (!tupleResult.ok) {
                if (tupleResult.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
                if (tupleResult.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
                if (tupleResult.error === "session_access_authentication_required") {
                    return reply.code(403).send({ error: "session_access_authentication_required" });
                }
                if (tupleResult.error === "session_access_authentication_unavailable") {
                    return reply.code(503).send({ error: "session_access_authentication_unavailable" });
                }
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
                if (tupleResult.error === "session_team_credential_binding_rejected") {
                    if (!tupleResult.reason) {
                        return reply.code(500).send({ error: "Failed to update session" });
                    }
                    return reply.code(409).send({
                        code: "session_team_credential_binding_rejected" as const,
                        reason: tupleResult.reason,
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

            // The tuple and its recipient cursors are committed. Realtime
            // publication cannot hold or contradict that mutation receipt.
            log({ module: "session-metadata", sessionId, mode: tupleBody.mode, phase: "committed" }, "Session metadata mutation committed");
            reply.send({
                success: true as const,
                metadataLayoutVersion: tupleResult.metadataLayoutVersion,
                sharedMetadata: { version: tupleResult.sharedMetadata.version },
                ...(tupleBody.mode !== "shared_editor"
                    ? { agentState: { version: tupleResult.agentState.version } }
                    : {}),
            });
            log({ module: "session-metadata", sessionId, mode: tupleBody.mode, phase: "publication_started" }, "Publishing committed Session metadata");
            try {
                const published = await publishSessionCurrentViewUpdates({
                    sessionId,
                    recipientCursors: tupleResult.recipientCursors,
                    source: {
                        kind: "envelope_tuple_v1",
                        sessionOwnerId: tupleResult.sessionOwnerId,
                        ownerAccountMode: tupleResult.ownerAccountMode,
                        sharedMetadata: tupleResult.sharedMetadata,
                        ownerMetadata: tupleResult.ownerMetadata,
                        agentState: tupleResult.agentState,
                        ...(tupleResult.changed ? { changed: tupleResult.changed } : {}),
                        ...(tupleResult.projectKey !== undefined ? { projectKey: tupleResult.projectKey } : {}),
                    },
                });
                log({ module: "session-metadata", sessionId, mode: tupleBody.mode,
                    phase: published.ok ? "publication_submitted" : "publication_failed",
                    ...(published.ok ? {} : { level: "warn" }) },
                published.ok ? "Submitted committed Session metadata publication" : "Failed to publish committed Session metadata");
            } catch {
                log({ module: "session-metadata", level: "warn", sessionId, mode: tupleBody.mode, phase: "publication_failed" }, "Failed to publish committed Session metadata");
            }
            return reply;
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
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

        const mode = conditionedMutation ? "inactive_model_intent" : "legacy";
        log({ module: "session-metadata", sessionId, mode, phase: "committed" }, "Session metadata mutation committed");
        if (conditionedMutation) {
            if (!result.metadata) {
                return reply.code(500).send({
                    error: "Failed to update session",
                });
            }
            reply.send(
                SessionMetadataInactiveModelIntentPatchSuccessV1Schema.parse({
                    success: true as const,
                    metadata: { version: result.metadata.version },
                }),
            );
        } else {
            reply.send({
                success: true as const,
                ...(result.metadata ? { metadata: { version: result.metadata.version } } : {}),
                ...(result.agentState ? { agentState: { version: result.agentState.version } } : {}),
            });
        }
        log({ module: "session-metadata", sessionId, mode, phase: "publication_started" }, "Publishing committed Session metadata");
        try {
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
            const published = currentSession ? await publishSessionCurrentViewUpdates({
                sessionId,
                recipientCursors: result.recipientCursors,
                source: { kind: "legacy_v0", sessionOwnerId: userId, session: currentSession },
            }) : { ok: false };
            log({ module: "session-metadata", sessionId, mode,
                phase: published.ok ? "publication_submitted" : "publication_failed",
                ...(published.ok ? {} : { level: "warn" }) },
            published.ok ? "Submitted committed Session metadata publication" : "Failed to publish committed Session metadata");
        } catch {
            log({ module: "session-metadata", level: "warn", sessionId, mode, phase: "publication_failed" }, "Failed to publish committed Session metadata");
        }
        return reply;
    });
}

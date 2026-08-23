import { z } from "zod";
import {
    SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
} from "@happier-dev/protocol";

import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import {
    applySessionAgentTransitionCutover,
    type ApplySessionAgentTransitionCutoverResult,
} from "@/app/session/agentTransition/applySessionAgentTransitionCutover";
import { publishSessionCurrentViewUpdates } from "@/app/session/metadata/publishSessionCurrentViewUpdates";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { SessionStoredMessageContentSchema } from "@happier-dev/protocol";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { type Fastify } from "../../types";

/**
 * The daemon-facing same-Session Agent transition cutover route.
 *
 * It routes an opaque sealed payload to `applySessionAgentTransitionCutover` and
 * adds no server-side Agent policy, decryption, or transition state. The server
 * never learns the Agent ids of an E2EE Session: the current view is compared by
 * metadata tuple/version CAS, not by a plaintext Agent field.
 *
 * `sessions.agentSwitching` is enforced HERE, through the shared server feature
 * gate, because this route is the only place the switch becomes durable. The
 * gate is enabled by default; a server owner who sets
 * `HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED=0` must actually refuse the
 * lifecycle mutation rather than merely stop advertising it, otherwise one
 * direct call still switches the Session. Clients keep learning the same answer
 * from the `/v1/features` bit this gate reads.
 */
export function registerSessionAgentTransitionRoute(
    app: Fastify,
    env: NodeJS.ProcessEnv = process.env,
) {
    const currentViewSchema = z.union([
        z.object({
            kind: z.literal("legacy_v0"),
            expectedMetadataVersion: z.number().int().min(0),
            metadataCiphertext: z.string().min(1),
            expectedAgentStateVersion: z.number().int().min(0),
            agentStateCiphertext: z.null(),
        }).strict(),
        z.object({
            kind: z.literal("envelope_tuple_v1"),
            ownerPatch: SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
        }).strict(),
    ]);

    app.post("/v2/sessions/:sessionId/agent-transition/cutover", {
        preHandler: [
            createServerFeatureGatePreHandler("sessions.agentSwitching", env),
            app.authenticate,
        ],
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                v: z.literal(1),
                currentView: currentViewSchema,
                divider: z.object({
                    localId: z.string().min(1),
                    content: SessionStoredMessageContentSchema,
                }).strict(),
            }).strict(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    dividerSeq: z.number().int().min(0),
                }).strict(),
                400: z.object({ error: z.literal("Invalid parameters") }).strict(),
                403: z.object({ error: z.literal("Forbidden") }).strict(),
                404: z.union([
                    z.object({ error: z.literal("Session not found") }).strict(),
                    // The server owner disabled `sessions.agentSwitching`. The
                    // shared gate answers before this handler runs.
                    z.object({ error: z.literal("not_found") }).strict(),
                ]),
                409: z.object({
                    effect: z.enum(["none", "current_view_committed"]),
                    error: z.enum([
                        "archived",
                        "session-active",
                        "version-mismatch",
                        "divider-conflict",
                        "divider-rejected",
                    ]),
                }).strict(),
                500: z.object({
                    effect: z.enum(["none", "current_view_committed"]),
                    error: z.literal("internal"),
                }).strict(),
            },
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;

        // The committed current view is announced through the SAME publisher
        // every other metadata writer uses, on EVERY path that committed it.
        // Without this the divider push would reach clients before anything told
        // them the Session's Agent changed, and the new identity would land only
        // on the next change-cursor catch-up. An exact retry commits nothing and
        // carries no publication.
        const publishCommittedCurrentView = async (
            committed: Extract<
                ApplySessionAgentTransitionCutoverResult,
                { currentView: unknown }
            >["currentView"],
        ): Promise<boolean> => {
            if (!committed.publication) return true;
            const published = await publishSessionCurrentViewUpdates({
                sessionId,
                participantCursors: committed.participantCursors,
                source: committed.publication,
            });
            return published.ok;
        };

        const result = await applySessionAgentTransitionCutover({
            actorUserId: request.userId,
            sessionId,
            currentView: request.body.currentView,
            divider: {
                localId: request.body.divider.localId,
                content: request.body.divider.content,
            },
        });

        if (!result.ok) {
            if (result.effect === "none") {
                if (result.error === "invalid-params") {
                    return reply.code(400).send({ error: "Invalid parameters" });
                }
                if (result.error === "forbidden") {
                    return reply.code(403).send({ error: "Forbidden" });
                }
                if (result.error === "session-not-found") {
                    return reply.code(404).send({ error: "Session not found" });
                }
                if (result.error === "internal") {
                    return reply.code(500).send({ effect: "none" as const, error: "internal" as const });
                }
                return reply.code(409).send({ effect: "none" as const, error: result.error });
            }
            // The current view DID commit, so it is announced before the divider
            // failure is reported. Not publishing it here would leave every other
            // connected client on the old Agent while this response already says
            // the write landed. A publication failure does not change the answer:
            // the divider error is the more specific truth and the same
            // committed-effect discriminator already tells the caller what
            // happened, so participants converge through their change cursor.
            await publishCommittedCurrentView(result.currentView);
            if (result.error === "internal") {
                return reply.code(500).send({
                    effect: "current_view_committed" as const,
                    error: "internal" as const,
                });
            }
            return reply.code(409).send({
                effect: "current_view_committed" as const,
                error: result.error,
            });
        }

        if (!await publishCommittedCurrentView(result.currentView)) {
            // The cutover DID commit, so this can never be reported as an
            // untouched Session. Participants still converge through their
            // change cursor.
            return reply.code(500).send({
                effect: "current_view_committed" as const,
                error: "internal" as const,
            });
        }

        // A same-localId re-append returns the existing sequence with nothing to
        // publish: no new sequence, no cursor movement, no republication.
        const write = result.dividerWrite;
        if (write?.didWrite) {
            await Promise.all(write.participantCursors.map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildNewMessageUpdate(
                        write.message,
                        sessionId,
                        cursor,
                        randomKeyNaked(12),
                        { attentionImpact: write.attentionImpact },
                    ),
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                });
            }));
            await publishSessionReadyProjectionUpdate({
                sessionId,
                readyProjection: write.readyProjection,
            });
        }
        if (write) {
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: write.badgeAttentionChanged,
                participantCursors: write.participantCursors,
            });
        }

        return reply.send({
            success: true as const,
            dividerSeq: result.dividerSeq,
        });
    });
}

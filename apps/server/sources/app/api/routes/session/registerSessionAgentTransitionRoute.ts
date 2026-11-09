import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from "zod/mini";
import { minLength } from "zod/mini";
import { SessionMetadataInactiveModelIntentOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import {
    applySessionAgentTransitionCutover,
    type ApplySessionAgentTransitionCutoverResult,
} from "@/app/session/agentTransition/applySessionAgentTransitionCutover";
import { publishSessionCurrentViewUpdates } from "@/app/session/metadata/publishSessionCurrentViewUpdates";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { UsageSessionTimingV1Schema, UsageTimingBoundsV1Schema } from '@happier-dev/protocol/usage/usageWorkEvidence';
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
        z.strictObject({
            kind: z.literal("legacy_v0"),
            expectedMetadataVersion: z.number().check(z.int(), z.minimum(0)),
            metadataCiphertext: z.string().check(z.minLength(1)),
            expectedAgentStateVersion: z.number().check(z.int(), z.minimum(0)),
            agentStateCiphertext: z.null(),
            usageTimingV1: z.optional(UsageSessionTimingV1Schema),
        }),
        z.strictObject({
            kind: z.literal("envelope_tuple_v1"),
            ownerPatch: SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
        }),
    ]);

    app.post("/v2/sessions/:sessionId/agent-transition/cutover", {
        preHandler: [
            createServerFeatureGatePreHandler("sessions.agentSwitching", env),
            app.authenticate,
        ],
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.strictObject({
                v: z.literal(1),
                currentView: currentViewSchema,
                divider: z.strictObject({
                    localId: z.string().check(z.minLength(1)),
                    content: SessionStoredMessageContentSchema,
                    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
                }),
                // The target Agent's Team slot bindings. The cutover is the
                // transition's one Session switch mutation, so the witness the
                // Home admits Team credential use through is written here, in the
                // current-view transaction (lane 10 child 01 principle 3).
                teamCredentialBindings: z.optional(lazyZodSchema(() => SessionTeamCredentialBindingIntentsV1Schema.check(minLength(1)))),
            }),
            response: {
                200: z.strictObject({
                    success: z.literal(true),
                    dividerSeq: z.number().check(z.int(), z.minimum(0)),
                }),
                400: z.strictObject({ error: z.literal("Invalid parameters") }),
                403: z.strictObject({ error: z.literal("Forbidden") }),
                404: z.union([
                    z.strictObject({ error: z.literal("Session not found") }),
                    // The server owner disabled `sessions.agentSwitching`. The
                    // shared gate answers before this handler runs.
                    z.strictObject({ error: z.literal("not_found") }),
                ]),
                409: z.strictObject({
                    effect: z.enum(["none", "current_view_committed"]),
                    error: z.enum([
                        "archived",
                        "session-active",
                        "version-mismatch",
                        "divider-conflict",
                        "divider-rejected",
                    ]),
                }),
                500: z.strictObject({
                    effect: z.enum(["none", "current_view_committed"]),
                    error: z.literal("internal"),
                }),
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
                recipientCursors: committed.recipientCursors,
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
                usageTimingV1: request.body.divider.usageTimingV1,
            },
            ...(request.body.teamCredentialBindings
                ? {
                    teamCredentialBindings: {
                        intents: request.body.teamCredentialBindings,
                        authentication: readSessionAccessAuthenticationFromRequest(request),
                    },
                }
                : {}),
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
            await Promise.all(write.recipientCursors.map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildNewMessageUpdate(
                        { ...write.message, accountActor: null },
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
        } else if (write?.didUpdate) {
            await Promise.all(write.recipientCursors.map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildMessageUpdatedUpdate(
                        { ...write.message, accountActor: null },
                        sessionId,
                        cursor,
                        randomKeyNaked(12),
                        { attentionImpact: write.attentionImpact },
                    ),
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                });
            }));
        }
        if (write) {
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: write.badgeAttentionChanged,
                sessionId,
            });
        }

        return reply.send({
            success: true as const,
            dividerSeq: result.dividerSeq,
        });
    });
}

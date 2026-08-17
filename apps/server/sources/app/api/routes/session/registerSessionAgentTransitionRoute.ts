import { z } from "zod";

import {
    SessionStoredMessageContentSchema,
    isSessionAgentTransitionDividerLocalId,
} from "@happier-dev/protocol";

import { buildNewMessageUpdate, buildUpdateSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { applySessionAgentTransitionCutover } from "@/app/session/agentTransition/applySessionAgentTransitionCutover";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { type Fastify } from "../../types";

/**
 * The owner-only Agent-transition cutover ingress.
 *
 * It is a separate route from `PATCH /v2/sessions/:sessionId` because the two
 * carry different preconditions and different partial-effect semantics: an
 * ordinary metadata patch has no lifecycle precondition and writes exactly one
 * thing, while the cutover requires an inactive, unarchived Session and reports
 * whether the divider landed after the current view committed. Folding it into
 * the patch route would give that route a second decision it does not own.
 *
 * The payload is opaque to the server: metadata and divider content arrive
 * already sealed by the daemon, so an E2EE Session is cut over without the
 * server reading Agent identity. The metadata/agentState version CAS is what
 * proves no concurrent change slipped in, since the server cannot compare the
 * expected Agent id itself.
 */
export function registerSessionAgentTransitionRoute(app: Fastify) {
    app.post('/v2/sessions/:sessionId/agent-transition/cutover', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                v: z.literal(1),
                currentView: z.object({
                    kind: z.literal('legacy_v0'),
                    expectedMetadataVersion: z.number().int().min(0),
                    metadataCiphertext: z.string().min(1),
                    expectedAgentStateVersion: z.number().int().min(0),
                    agentStateCiphertext: z.null(),
                }).strict(),
                divider: z.object({
                    localId: z.string().min(1),
                    content: SessionStoredMessageContentSchema,
                }).strict(),
            }).strict(),
            response: {
                200: z.union([
                    z.object({
                        ok: z.literal(true),
                        dividerSeq: z.number().int().min(0),
                        dividerDidWrite: z.boolean(),
                        currentView: z.object({
                            kind: z.literal('legacy_v0'),
                            metadataVersion: z.number().int().min(0),
                            agentStateVersion: z.number().int().min(0),
                        }),
                    }),
                    z.object({
                        ok: z.literal(false),
                        effect: z.literal('current_view_committed'),
                        error: z.enum(['divider-conflict', 'divider-rejected', 'internal']),
                        currentView: z.object({
                            kind: z.literal('legacy_v0'),
                            metadataVersion: z.number().int().min(0),
                            agentStateVersion: z.number().int().min(0),
                        }),
                    }),
                    z.object({
                        ok: z.literal(false),
                        effect: z.literal('none'),
                        error: z.enum([
                            'invalid-params',
                            'forbidden',
                            'session-not-found',
                            'archived',
                            'session-active',
                            'version-mismatch',
                            'internal',
                        ]),
                    }),
                ]),
                400: z.object({ error: z.literal('Invalid parameters'), code: z.string().optional() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { currentView, divider } = request.body;

        if (!isSessionAgentTransitionDividerLocalId(divider.localId)) {
            return reply.code(400).send({ error: 'Invalid parameters', code: 'divider-local-id-not-reserved' });
        }

        const result = await applySessionAgentTransitionCutover({
            actorUserId: userId,
            sessionId,
            currentView,
            divider,
        });

        if (!result.ok && result.effect === 'none') {
            return reply.send({ ok: false as const, effect: 'none' as const, error: result.error });
        }

        // Both remaining shapes committed the current view, so both fan the new
        // metadata/agentState out. Only the success shape also has a divider row.
        const metadataUpdate = { value: result.metadataCiphertext, version: result.currentView.metadataVersion };
        const agentStateUpdate = { value: result.agentStateCiphertext, version: result.currentView.agentStateVersion };
        await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
            eventRouter.emitUpdate({
                userId: accountId,
                payload: buildUpdateSessionUpdate(sessionId, cursor, randomKeyNaked(12), metadataUpdate, agentStateUpdate),
                recipientFilter: { type: 'all-interested-in-session', sessionId },
            });
        }));

        if (!result.ok) {
            return reply.send({
                ok: false as const,
                effect: 'current_view_committed' as const,
                error: result.error,
                currentView: result.currentView,
            });
        }

        if (result.dividerDidWrite) {
            await Promise.all(result.dividerParticipantCursors.map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildNewMessageUpdate(result.dividerMessage, sessionId, cursor, randomKeyNaked(12), {
                        attentionImpact: result.attentionImpact,
                    }),
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
        }

        return reply.send({
            ok: true as const,
            dividerSeq: result.dividerSeq,
            dividerDidWrite: result.dividerDidWrite,
            currentView: result.currentView,
        });
    });
}

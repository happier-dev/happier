import { z } from "zod";

import { SessionStoredMessageContentSchema } from "@happier-dev/protocol";

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
 *
 * The response is the ONE cutover contract, shared with the successor tree: the
 * outcome rides the HTTP status — 200 for a committed cutover, 409/500 carrying
 * the explicit partial-effect discriminator, and 400/403/404 for the refusals
 * that wrote nothing. That is how every other session route in this server
 * reports itself, and the daemon reader
 * (`apps/cli/src/session/transport/http/sessionAgentTransitionHttp.ts`) is the
 * other half of it.
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
                200: z.object({
                    success: z.literal(true),
                    dividerSeq: z.number().int().min(0),
                }).strict(),
                400: z.object({ error: z.literal('Invalid parameters') }).strict(),
                403: z.object({ error: z.literal('Forbidden') }).strict(),
                404: z.object({ error: z.literal('Session not found') }).strict(),
                409: z.object({
                    effect: z.enum(['none', 'current_view_committed']),
                    error: z.enum([
                        'archived',
                        'session-active',
                        'version-mismatch',
                        'divider-conflict',
                        'divider-rejected',
                    ]),
                }).strict(),
                500: z.object({
                    effect: z.enum(['none', 'current_view_committed']),
                    error: z.literal('internal'),
                }).strict(),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { currentView, divider } = request.body;

        // The reserved-localId precondition is NOT re-decided here. The command
        // owner already refuses a non-reserved localId with `invalid-params`,
        // and a second copy of that rule at the ingress is a second
        // decision-maker for the namespace the command exists to protect.
        const result = await applySessionAgentTransitionCutover({
            actorUserId: userId,
            sessionId,
            currentView,
            divider,
        });

        if (!result.ok && result.effect === 'none') {
            if (result.error === 'invalid-params') {
                return reply.code(400).send({ error: 'Invalid parameters' as const });
            }
            if (result.error === 'forbidden') {
                return reply.code(403).send({ error: 'Forbidden' as const });
            }
            if (result.error === 'session-not-found') {
                return reply.code(404).send({ error: 'Session not found' as const });
            }
            if (result.error === 'internal') {
                return reply.code(500).send({ effect: 'none' as const, error: 'internal' as const });
            }
            return reply.code(409).send({ effect: 'none' as const, error: result.error });
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
            if (result.error === 'internal') {
                return reply.code(500).send({
                    effect: 'current_view_committed' as const,
                    error: 'internal' as const,
                });
            }
            return reply.code(409).send({
                effect: 'current_view_committed' as const,
                error: result.error,
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

        // `dividerDidWrite` and the committed versions stay INTERNAL: they drive
        // the fan-out above, and the daemon has never read either. Publishing
        // them would be contract surface with no consumer.
        return reply.send({
            success: true as const,
            dividerSeq: result.dividerSeq,
        });
    });
}

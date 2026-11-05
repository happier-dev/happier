import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { projectSessionTurnWaitingHttpResponse } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { z } from "zod/mini";
import { SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS, SessionHistoricalTranscriptImportV3Schema, SessionTranscriptSurfaceItemReferenceInputV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics/index";
import { SessionMessageDeliveryResolutionV1Schema, readStoredSessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { FollowDeliveryProjectionV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { MessageActionDurableResolutionV1Schema, MessageActionReferenceV1Schema } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { ExternalShareableActorV1Schema, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1, ExternalShareableTranscriptSnapshotV1Schema, deriveExternalShareableActorFromAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionTurnV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/messages/sessionTranscriptPageLimits';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionTranscriptObservationProvenanceV1Schema, isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { isSessionAgentTransitionDividerLocalId } from '@happier-dev/protocol/sessions/agentTransitionDivider';
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    importHistoricalSessionTranscript,
    type HistoricalSessionTranscriptImportItem,
} from "@/app/session/importHistoricalSessionTranscript";
import {
    projectSessionMessageAccountActors,
    resolveSessionMessageAccountActor,
} from "@/app/session/messages/projectSessionMessageAccountActors";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import {
    issueSessionMessageActionReference,
    resolveSessionMessageActionLookup,
} from "@/app/session/sessionMessageActionLookup";
import {
    buildSessionMessagePublicationWhere,
    buildShareableSessionMessagePublicationWhere,
    isExternalShareableSessionTurnVisible,
    isSessionTranscriptPublicationBlocked,
    loadSessionTranscriptPublication,
    resolveExternalShareableTranscriptBlockedFromSeq,
    resolveExternalShareableTranscriptTurnSettlementBlockedFromSeq,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { parseStoredSessionTurns } from "@/app/session/turns/parseSessionTurnState";
import { isSessionTurnTranscriptAnchorProjectionCurrent } from "@/app/session/turns/sessionTurnTranscriptAnchorProjection";
import {
    resolveSessionTurnProjectionSeqs,
    type SessionTurnProjectionSeqs,
} from "./resolveSessionTurnProjectionSeqs";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { readCurrentSessionAccessForOperation, resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { inReadSnapshot, inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { projectSessionInputAdmissionReceipt } from "@/app/session/messages/sessionInputAdmission";
import { projectSessionFollowWakeBatchDelivery } from "@/app/session/follow/projectSessionFollowWakeBatchDelivery";
import { readSessionMessageRepliesInTx, readSessionMessageReplyInTx, mutateSessionMessageReplyForAccountInTx, listSessionMessageRepliesPendingInTx } from '@/app/session/messages/sessionMessageReply';
import { readCommittedSessionMessageInTx } from '@/app/session/messages/readCommittedSessionMessage';
import { SessionMessageReplyReadResultV1Schema, SessionMessageReplyMutationResultV1Schema, SessionMessageReplyPendingPageV1Schema, SessionMessageReplyCapabilityV1Schema, SessionMessageReplyAccountMutationV1Schema,
    SessionMessageReplyReadBatchRequestV1Schema, SessionMessageReplyReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

import { readSessionMessagePage } from './readSessionMessagePage';
export { readSessionMessagePage } from './readSessionMessagePage';
import { SessionTranscriptMessagePageResponseSchema, SessionTranscriptStoredContentUnavailableResponseSchema } from './sessionMessagePageProjection';

export function registerSessionMessageRoutes(app: Fastify) {
    app.post('/v1/sessions/:sessionId/messages/action-reference/resolve', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: MessageActionReferenceV1Schema,
            response: {
                200: MessageActionDurableResolutionV1Schema,
                404: z.strictObject({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages"),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const reference = request.body;
        const authentication = readSessionAccessAuthenticationFromRequest(request);

        // The caller supplies one opaque reference only. A mismatched route
        // segment never becomes a second Message identity or an existence
        // oracle.
        if (reference.sessionId !== sessionId) {
            return reply.send({ status: "unavailable" });
        }

        const resolution = await inReadSnapshot(async (tx) => await resolveSessionMessageActionLookup({
            actorUserId: request.userId,
            sessionId,
            messageId: reference.messageId,
            reference,
            readAccess: async (actorUserId, ownedSessionId) =>
                (await resolveSessionAccessForOperation(tx, { accountId: actorUserId, sessionId: ownedSessionId, authentication })).status === "allowed",
            readMessage: async (ownedSessionId, messageId) => await tx.sessionMessage.findFirst({
                where: {
                    id: messageId,
                    sessionId: ownedSessionId,
                    session: { AND: [{ id: ownedSessionId }, await buildSessionAccessWhere({ tx, accountId: request.userId, capability: 'readTranscript', mode: 'effective_access_v1', authentication })] },
                },
                select: {
                    id: true,
                    sessionId: true,
                    seq: true,
                    messageRole: true,
                    updatedAt: true,
                },
            }),
            readPublication: async (ownedSessionId) => {
                if ((await resolveSessionAccessForOperation(tx, { accountId: request.userId, sessionId: ownedSessionId, authentication })).status !== "allowed") return null;
                return await tx.session.findFirst({
                    where: { AND: [{ id: ownedSessionId }, await buildSessionAccessWhere({ tx, accountId: request.userId, capability: 'readTranscript', mode: 'effective_access_v1', authentication })] },
                    select: SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                });
            },
        }));
        if (resolution.status !== "unavailable" && (await readCurrentSessionAccessForOperation({
            accountId: request.userId, sessionId, authentication, capability: "readTranscript",
        })).status !== "allowed") {
            return reply.send({ status: "unavailable" });
        }
        return reply.send(resolution);
    });

    app.get('/v2/sessions/:sessionId/messages/reply-capability', {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
        schema: { params: z.strictObject({ sessionId: z.string() }), response: { 200: SessionMessageReplyCapabilityV1Schema,
            404: z.strictObject({ error: z.literal('Session not found') }) } },
    }, async (request, reply) => {
        const access = await readCurrentSessionAccessForOperation({ accountId: request.userId, sessionId: request.params.sessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request), capability: 'readTranscript' });
        if (access.status !== 'allowed') return reply.code(404).send({ error: 'Session not found' });
        return reply.send(SessionMessageReplyCapabilityV1Schema.parse({ v: 1, protocolVersions: [1] }));
    });

    app.post('/v2/sessions/messages/replies/read-batch', {
        preHandler: app.authenticate,
        // Account UI transport, like the existing Session read batch. Restricted
        // credentials keep using the exact Session-bound reply endpoint.
        schema: { body: SessionMessageReplyReadBatchRequestV1Schema, response: { 200: SessionMessageReplyReadBatchResponseV1Schema } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const results = await inReadSnapshot(tx => readSessionMessageRepliesInTx(tx, {
            requests: request.body.requests, accountId: request.userId, authentication,
        }));
        return reply.header('Cache-Control', 'no-store').send({ results });
    });

    app.get('/v2/sessions/:sessionId/messages/replies/pending', {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' }, apiTokenSessionAction: 'session.transcript.get' },
        schema: { params: z.strictObject({ sessionId: z.string() }), querystring: z.strictObject({ afterLocalId: z.optional(z.string().check(z.minLength(1))) }),
            response: { 200: SessionMessageReplyPendingPageV1Schema } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const params = { accountId: request.userId, sessionId: request.params.sessionId, afterLocalId: request.query.afterLocalId, authentication };
        const result = await inReadSnapshot(tx => listSessionMessageRepliesPendingInTx(tx, params));
        if ((await readCurrentSessionAccessForOperation({ accountId: params.accountId, sessionId: params.sessionId,
            authentication, capability: 'readTranscript' })).status !== 'allowed') return reply.send({ v: 1, entries: [], nextAfterLocalId: null });
        const entries = await inReadSnapshot(async tx => {
            const admitted = [];
            for (const entry of result.entries) {
                const current = await readSessionMessageReplyInTx(tx, { ...params, localId: entry.requestLocalId });
                if (current.status === 'available') admitted.push(entry);
            }
            return admitted;
        });
        return reply.send({ ...result, entries });
    });

    app.post('/v2/sessions/:sessionId/messages/by-local-id/:localId/reply', {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' }, apiTokenSessionAction: 'session.message.send' },
        schema: { params: z.strictObject({ sessionId: z.string(), localId: z.string().check(z.minLength(1)) }),
            body: SessionMessageReplyAccountMutationV1Schema, response: { 200: SessionMessageReplyMutationResultV1Schema } },
    }, async (request, reply) => reply.send(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, {
        accountId: request.userId, sessionId: request.params.sessionId, localId: request.params.localId,
        ...request.body, authentication: readSessionAccessAuthenticationFromRequest(request),
    }), { isolationLevel: 'ReadCommitted' })));

    app.get('/v2/sessions/:sessionId/messages/by-local-id/:localId/reply', {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' }, apiTokenSessionAction: 'session.transcript.get' },
        schema: { params: z.strictObject({ sessionId: z.string(), localId: z.string().check(z.minLength(1)) }),
            response: { 200: SessionMessageReplyReadResultV1Schema } },
    }, async (request, reply) => {
        const params = { accountId: request.userId, sessionId: request.params.sessionId, localId: request.params.localId,
            authentication: readSessionAccessAuthenticationFromRequest(request) };
        const result = await inReadSnapshot(tx => readSessionMessageReplyInTx(tx, params));
        if (result.status === 'available' && ((await readCurrentSessionAccessForOperation({ accountId: params.accountId,
            sessionId: params.sessionId, authentication: params.authentication, capability: 'readTranscript' })).status !== 'allowed'
            || (await inReadSnapshot(tx => readSessionMessageReplyInTx(tx, params))).status !== 'available')) {
            return reply.send({ v: 1, status: 'unavailable' });
        }
        return reply.send(result);
    });

    app.get('/v2/sessions/:sessionId/messages/by-local-id/:localId', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                localId: z.string().check(z.minLength(1)),
            }),
            response: {
                200: z.looseObject({
                    message: z.looseObject({
                        id: z.string(),
                        seq: z.number().check(z.int(), z.minimum(0)),
                        localId: z.nullable(z.string()),
                        sidechainId: z.optional(z.nullable(z.string())),
                        messageRole: z.optional(z.nullable(SessionMessageRoleSchema)),
                        deliveryResolution: z.optional(SessionMessageDeliveryResolutionV1Schema),
                        followDeliveryProjection: z.optional(FollowDeliveryProjectionV1Schema),
                        content: SessionStoredMessageContentSchema,
                        createdAt: z.number().check(z.int(), z.minimum(0)),
                        updatedAt: z.number().check(z.int(), z.minimum(0)),
                        sourceCreatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
                        sourceUpdatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
                        transcriptObservationProvenance: z.optional(SessionTranscriptObservationProvenanceV1Schema),
                        accountActor: z.nullable(SessionMessageAccountActorV1Schema),
                        inputAdmissionReceipt: z.optional(SessionInputAdmissionReceiptV1Schema),
                        acceptedTurnId: z.optional(z.string()),
                        turnStartWitnessId: z.optional(z.string()),
                        turn: z.optional(SessionTurnV1Schema),
                    }),
                }),
                404: z.looseObject({ error: z.string() }),
                403: z.union([
                    z.strictObject({ error: z.literal("team_authentication_required") }),
                    z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.strictObject({ error: z.literal("credential_scope_denied") }),
                ]),
                503: z.strictObject({ error: z.literal("team_authentication_unavailable") }),
            },
        },
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages.byLocalId"),
            apiTokenSessionAction: "session.transcript.get",
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, localId } = request.params;
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const targetMachineId = authentication.apiTokenGrant
            ? await app.resolveCurrentSessionMachine?.({ accountId: userId, sessionId }) : undefined;

        const { row, accessDecision: snapshotAccessDecision, accountActor } = await inReadSnapshot(tx =>
            readCommittedSessionMessageInTx(tx, { accountId: userId, sessionId, localId, authentication, targetMachineId }));
        const accessDecision = snapshotAccessDecision.status === "allowed"
            ? await readCurrentSessionAccessForOperation({ accountId: userId, sessionId, authentication, capability: "readTranscript" })
            : snapshotAccessDecision;
        if (accessDecision.status === "authentication_required") {
            return reply.code(403).send({ error: "team_authentication_required" });
        }
        if (accessDecision.status === "authentication_unavailable") {
            return reply.code(503).send({ error: "team_authentication_unavailable" });
        }
        if (accessDecision.status !== "allowed") {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (!row) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        const messageRole = parseSessionMessageRole(row.messageRole);
        return reply.send({
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId,
                ...(typeof row.sidechainId === "string" && row.sidechainId ? { sidechainId: row.sidechainId } : {}),
                ...(messageRole ? { messageRole } : {}),
                content: row.content,
                accountActor,
                ...projectSessionInputAdmissionReceipt(row.inputAdmissionReceipt),
                ...(row.acceptedTurnId ? { acceptedTurnId: row.acceptedTurnId } : {}),
                ...(row.turnStartWitnessId ? { turnStartWitnessId: row.turnStartWitnessId } : {}),
                ...(row.turn ? { turn: row.turn } : {}),
                ...(() => {
                    const deliveryResolution = readStoredSessionMessageDeliveryResolutionV1(row.deliveryResolution);
                    return deliveryResolution ? { deliveryResolution } : {};
                })(),
                ...projectSessionFollowWakeBatchDelivery(row),
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
                ...(row.sourceCreatedAt ? { sourceCreatedAt: row.sourceCreatedAt.getTime() } : {}),
                ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt.getTime() } : {}),
                ...(() => {
                    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(row.transcriptObservationProvenance);
                    return provenance.success ? { transcriptObservationProvenance: provenance.data } : {};
                })(),
            },
        });
    });

    app.get('/v1/sessions/:sessionId/messages', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.optional(z.object({
                messageId: z.optional(z.string().check(z.minLength(1))),
                scope: z.optional(z.enum(["main", "sidechain", "all"])),
                sidechainId: z.optional(z.string().check(z.minLength(1))),
                limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1))),
                beforeSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(1))),
                afterSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
                role: z.optional(SessionMessageRoleSchema),
                roles: z.optional(z.string()),
                projection: z.optional(z.enum(["externalShareableV1", "turns"])),
            }).check(z.superRefine((value, ctx) => {
                if (value.messageId !== undefined && (value.beforeSeq !== undefined
                    || value.afterSeq !== undefined || value.limit !== undefined || value.projection !== undefined)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Exact message selection and history paging or projection are mutually exclusive",
                    });
                }
                if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
                    ctx.addIssue({
                        code: "custom",
                        message: 'beforeSeq and afterSeq are mutually exclusive',
                    });
                }
                if (value.scope === "sidechain" && typeof value.sidechainId !== "string") {
                    ctx.addIssue({
                        code: "custom",
                        message: "sidechainId is required when scope=sidechain",
                    });
                }
                if (value.projection === "turns" && value.afterSeq !== undefined) {
                    ctx.addIssue({
                        code: "custom",
                        message: "projection=turns pages backwards only",
                    });
                }
                if (value.projection === "turns" && value.scope === "all") {
                    // A turn is an ordering within ONE chain; interleaving chains would pair a
                    // prompt with a reply from a different conversation.
                    ctx.addIssue({
                        code: "custom",
                        message: "projection=turns requires a single chain scope",
                    });
                }
                if (
                    value.projection === "externalShareableV1"
                    && value.limit !== undefined
                    && value.limit > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1
                ) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["limit"],
                        message: `externalShareableV1 pages are limited to ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1} rows`,
                    });
                }
            }))),
            response: {
                200: SessionTranscriptMessagePageResponseSchema,
                400: z.looseObject({
                    error: z.string(),
                    code: z.string(),
                }),
                403: z.union([
                    z.strictObject({ error: z.literal("team_authentication_required") }),
                    z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.strictObject({ error: z.literal("credential_scope_denied") }),
                ]),
                404: z.strictObject({ error: z.string() }),
                503: z.union([
                    SessionTranscriptStoredContentUnavailableResponseSchema,
                    z.strictObject({ error: z.literal("team_authentication_unavailable") }),
                ]),
            },
        },
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages"),
            apiTokenSessionAction: "session.transcript.get",
        },
    }, async (request, reply) => {
        const result = await readSessionMessagePage({ userId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request), query: request.query, previewRequest: request });
        return reply.code(result.status).send(result.body);
    });

    for (const epoch of [2, 3] as const) app.post(`/v${epoch}/sessions/:sessionId/transcript/import`, {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: epoch === 3 ? SessionHistoricalTranscriptImportV3Schema : z.object({
                items: z.array(z.object({
                    localId: z.string().check(z.trim(), z.minLength(1)),
                    content: SessionStoredMessageContentSchema,
                    messageRole: z.optional(SessionMessageRoleSchema),
                })).check(z.minLength(1), z.maxLength(SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS)),
            }),
            response: {
                200: z.strictObject({
                    imported: z.number().check(z.int(), z.minimum(0)),
                    cursor: z.nullable(z.number().check(z.int(), z.minimum(0))),
                }),
                400: z.strictObject({ error: z.literal("Invalid parameters"), code: z.optional(z.string()) }),
                403: z.strictObject({ error: z.literal("Forbidden") }),
                404: z.strictObject({ error: z.literal("Session not found") }),
                500: z.strictObject({ error: z.literal("Failed to import transcript") }),
            },
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const body = request.body as Readonly<{
            items: readonly HistoricalSessionTranscriptImportItem[];
        }>;
        const result = await importHistoricalSessionTranscript({
            actorUserId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            sessionId,
            items: body.items,
        });
        if (!result.ok) {
            if (result.error === "forbidden") {
                return reply.code(403).send({ error: "Forbidden" });
            }
            if (result.error === "session-not-found") {
                return reply.code(404).send({ error: "Session not found" });
            }
            if (result.error === "internal") {
                return reply.code(500).send({ error: "Failed to import transcript" });
            }
            return reply.code(400).send({
                error: "Invalid parameters",
                ...(result.code ? { code: result.code } : {}),
            });
        }
        return reply.send({
            imported: result.imported,
            cursor: result.cursor,
        });
    });

    app.post('/v2/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            apiTokenSessionAction: "session.message.send",
        },
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.union([
                z.object({
                    ciphertext: z.string().check(z.minLength(1)),
                    localId: z.optional(z.string()),
                    sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
                    messageRole: z.optional(z.unknown()),
                    sessionEventType: z.optional(z.literal("ready")),
                    // Released callers may still send this retired hint. It is
                    // parsed only for compatibility and never selects admission.
                    transcriptOnly: z.optional(z.boolean()),
                }),
                z.object({
                    content: SessionStoredMessageContentSchema,
                    localId: z.optional(z.string()),
                    sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
                    messageRole: z.optional(z.unknown()),
                    sessionEventType: z.optional(z.literal("ready")),
                    // See the encrypted arm above. Public writes always retain
                    // authenticated Account authorship.
                    transcriptOnly: z.optional(z.boolean()),
                }),
            ]),
            response: {
                200: z.looseObject({
                        didWrite: z.boolean(),
                        didUpdate: z.optional(z.boolean()),
                        message: z.object({
                            id: z.string(),
                            seq: z.number().check(z.int(), z.minimum(0)),
                            localId: z.nullable(z.string()),
                            createdAt: z.number().check(z.int(), z.minimum(0)),
                        }),
                    }),
                400: z.looseObject({ error: z.literal('Invalid parameters'), code: z.optional(z.string()) }),
                403: z.union([
                    z.object({ error: z.literal('Forbidden') }),
                    z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.strictObject({ error: z.literal("credential_scope_denied") }),
                ]),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to create message') }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const body = request.body as Readonly<{
            localId?: string;
            sidechainId?: string | null;
            messageRole?: unknown;
            sessionEventType?: "ready";
            transcriptOnly?: boolean;
        } & ({ ciphertext: string } | { content: SessionStoredMessageContent })>;
        const trustedSessionEventType = body.sessionEventType === "ready" ? "ready" : undefined;
        const localId = typeof body.localId === "string" ? body.localId : undefined;
        const parsedSidechainId = parseSessionMessageSidechainId(body.sidechainId, { emptyString: "invalid" });
        if (!parsedSidechainId.ok) {
            return reply.code(400).send({ error: "Invalid parameters", code: "invalid-sidechain-id" });
        }
        const sidechainId = parsedSidechainId.sidechainId;

        const headerKey = request.headers["idempotency-key"];
        const idempotencyKey =
            typeof headerKey === "string"
                ? headerKey
                : Array.isArray(headerKey) && typeof headerKey[0] === "string"
                    ? headerKey[0]
                    : null;

        const effectiveLocalId = localId ?? idempotencyKey ?? null;

        // The Agent-transition divider local-ID namespace is reserved. Only the
        // owner-only transition service may pass one to `createSessionMessage`;
        // a generic client ingress must never mint or overwrite a divider row.
        if (isSessionAgentTransitionDividerLocalId(effectiveLocalId)) {
            return reply.code(400).send({
                error: "Invalid parameters",
                code: "session_message_reserved_local_id",
            });
        }

        // This public route is an authenticated Account boundary. Transcript-only
        // observation is reserved for the existing publisher/runtime owners; a
        // caller-controlled flag must never suppress immutable human authorship.
        const inputAdmission = {
            inputAdmission: "authenticatedAccount" as const,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        };
        const result =
            "content" in body
                ? await createSessionMessage({
                      actorUserId: userId,
                      ...inputAdmission,
                      sessionId,
                      content: body.content,
                      localId: effectiveLocalId,
                      sidechainId,
                      messageRole: body.messageRole,
                      ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
                  })
                : await createSessionMessage({
                      actorUserId: userId,
                      ...inputAdmission,
                      sessionId,
                      ciphertext: body.ciphertext,
                      localId: effectiveLocalId,
                      sidechainId,
                      messageRole: body.messageRole,
                      ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
                  });

        if (!result.ok) {
            if (result.error === "invalid-params") {
                const payload: { error: "Invalid parameters"; code?: string } = { error: "Invalid parameters" };
                if ("code" in result && typeof result.code === "string") payload.code = result.code;
                return reply.code(400).send(payload);
            }
            if (result.error === "local-id-conflict") return reply.code(400).send({ error: "Invalid parameters", code: "session_input_idempotency_conflict" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to create message" });
        }

        // One evaluation per publication: every recipient of this row sees the
        // same actor semantics the authenticated page would return.
        const publishedMessage = {
            ...result.message,
            accountActor: await resolveSessionMessageAccountActor(result.message),
        };

        if (result.didWrite) {
            await Promise.all(result.recipientCursors.map(async ({ accountId, cursor }) => {
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = options
                    ? buildNewMessageUpdate(publishedMessage, sessionId, cursor, randomKeyNaked(12), options)
                    : buildNewMessageUpdate(publishedMessage, sessionId, cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
            await publishSessionReadyProjectionUpdate({
                sessionId,
                readyProjection: result.readyProjection,
            });
        } else if (result.didUpdate) {
            await Promise.all(result.recipientCursors.map(async ({ accountId, cursor }) => {
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = options
                    ? buildMessageUpdatedUpdate(publishedMessage, sessionId, cursor, randomKeyNaked(12), options)
                    : buildMessageUpdatedUpdate(publishedMessage, sessionId, cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
        }

        await refreshTrackedSessionAccountBadgePushes({
            badgeAttentionChanged: result.badgeAttentionChanged,
            sessionId,
        });

        return reply.send({
            didWrite: result.didWrite,
            ...(result.didUpdate ? { didUpdate: true } : {}),
            message: {
                id: result.message.id,
                seq: result.message.seq,
                localId: result.message.localId,
                createdAt: result.message.createdAt.getTime(),
            },
        });
    });
}

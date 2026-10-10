import { z } from "zod";
import type { FastifyReply } from "fastify";
import { type Fastify } from "../../types";
import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import {
    deletePendingMessage,
    dismissPendingDelivery,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    listPendingResetStartsForSource,
    blockPendingDelivery,
    markPendingActivationFailed,
    markPendingDeliveryHandled,
    reorderPendingMessages,
    sendPendingDeliveryAsNew,
    restorePendingMessage,
    updatePendingRequestedAction,
    updatePendingMessage,
    type PendingMessageRow,
} from "@/app/session/pending/pendingMessageService";
import {
    resolveSessionMessageAccountActor,
    type SessionMessageAccountActorSourceRow,
} from "@/app/session/messages/projectSessionMessageAccountActors";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import {
    isSessionAgentTransitionDividerLocalId,
    ExecutionRunIdSchema,
    SessionExecutionRunPendingEnqueueRequestV1Schema,
    PendingDeliveryBlockedReasonSchema,
    PendingLocalIdSchema,
    PendingMessageMutationFingerprintV1Schema,
    PendingRequestedActionV1Schema,
    PendingActivationFailureRequestV1Schema,
    SessionStoredMessageContentSchema,
    StrictSessionStoredMessageContentEnvelopeSchema,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { PendingResetStartsReadInputV1Schema, PendingResetStartsReadResultV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import {
    emitPendingChanged,
} from "@/app/session/pending/publishPendingMutation";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

function toPendingJson(row: PendingMessageRow) {
    return {
        localId: row.localId,
        ...(row.recipient ? { recipient: row.recipient } : {}),
        ...(typeof row.messageRole === "string" ? { messageRole: row.messageRole } : {}),
        content: row.content,
        ...(row.requestedAction ? { requestedAction: row.requestedAction } : {}),
        ...(row.requestedActionMalformed ? { requestedActionMalformed: true } : {}),
        status: row.status,
        deliveryStatus: row.deliveryStatus,
        ...(row.deliveryState ? { deliveryState: row.deliveryState } : {}),
        ...(row.deliveryBlockedReason ? { deliveryBlockedReason: row.deliveryBlockedReason } : {}),
        position: row.position,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        discardedAt: row.discardedAt ? row.discardedAt.getTime() : null,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
        accountActor: row.accountActor,
    };
}

function getOptionalErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const code = "admissionRejectionCode" in value ? value.admissionRejectionCode : "code" in value ? value.code : undefined;
    return typeof code === "string" && code.length > 0 ? code : undefined;
}

function sendTransactionUnavailable(
    reply: FastifyReply,
    result: Readonly<{ error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string }>,
) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))));
    return reply.code(503).send({
        error: result.error,
        retryAfterMs: result.retryAfterMs,
        ...(result.correlationId ? { correlationId: result.correlationId } : {}),
    });
}

function pendingAuthenticationStatus(error: string): 403 | 503 | null {
    if (error === "session_access_authentication_required") return 403;
    if (error === "session_access_authentication_unavailable") return 503;
    return null;
}

function toPendingStateJson(value: { pendingCount: number; pendingBlockedCount?: number; pendingVersion: number }, runId?: string) {
    if (runId) return { pendingVersion: value.pendingVersion, recipient: { kind: "execution_run" as const, runId } };
    return {
        pendingCount: value.pendingCount,
        ...(typeof value.pendingBlockedCount === "number" ? { pendingBlockedCount: value.pendingBlockedCount } : {}),
        pendingVersion: value.pendingVersion,
    };
}

async function emitCommittedPendingDeliveryMessage(params: {
    sessionId: string;
    message?: Parameters<typeof buildNewMessageUpdate>[0] & SessionMessageAccountActorSourceRow;
    eventKind?: "new-message" | "message-updated";
    recipientCursors?: Array<{ accountId: string; cursor: number }>;
    readyProjection?: Parameters<typeof publishSessionReadyProjectionUpdate>[0]["readyProjection"];
}): Promise<void> {
    if (!params.message || !params.recipientCursors || params.recipientCursors.length === 0) return;
    const buildMessageUpdate = params.eventKind === "message-updated"
        ? buildMessageUpdatedUpdate
        : buildNewMessageUpdate;
    // Settlement and materialization publish the same actor the authenticated
    // page resolves, so the row never visually switches authors when a Pending
    // card becomes a transcript message.
    const message = {
        ...params.message,
        accountActor: await resolveSessionMessageAccountActor(params.message),
    };
    const results = await Promise.allSettled(
        params.recipientCursors.map(async ({ accountId, cursor }) => {
            const payload = buildMessageUpdate(message, params.sessionId, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.recipientCursors?.[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-routes", level: "warn", sessionId: params.sessionId, accountId },
            params.eventKind === "message-updated"
                ? "failed to emit message-updated update after pending delivery resolution"
                : "failed to emit new-message update after pending delivery resolution",
            result.reason,
        );
    });
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: params.readyProjection,
    });
}

export function sessionPendingRoutes(app: Fastify) {
    app.post('/v2/pending/reset-starts/read', {
        preHandler: app.authenticate,
        schema: { body: PendingResetStartsReadInputV1Schema, response: { 200: PendingResetStartsReadResultV1Schema } },
        config: { restrictedCredentialBinding: { scope: 'account' },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, 'session.pending') },
    }, async request => listPendingResetStartsForSource({ actorUserId: request.userId,
        authentication: readSessionAccessAuthenticationFromRequest(request), source: request.body.source }));
    registerSessionPendingResource(app, false);
    registerSessionPendingResource(app, true);
}

function registerSessionPendingResource(app: Fastify, executionRunTarget: boolean) {
    const basePath = executionRunTarget
        ? "/v2/sessions/:sessionId/execution-runs/:runId/pending"
        : "/v2/sessions/:sessionId/pending";
    const runId = executionRunTarget ? ExecutionRunIdSchema : z.never().optional();
    const mutationBody = <T extends z.ZodRawShape>(shape: T) => executionRunTarget ? z.object(shape).strict() : z.object(shape);
    app.get(
        basePath,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string() }),
                querystring: z
                    .object({
                        includeDiscarded: z
                            .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
                            .optional(),
                    })
                    .optional(),
            },
            config: {
                restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(!executionRunTarget ? { apiTokenSessionAction: "session.transcript.get" as const } : {}),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const includeDiscardedRaw = request.query?.includeDiscarded;
            const includeDiscarded = includeDiscardedRaw === "true" || includeDiscardedRaw === "1";

            const res = await listPendingMessages({
                actorUserId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId,
                ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                includeDiscarded,
            });

            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                const payload: { error: string; code?: string } = { error: res.error };
                const code = getOptionalErrorCode(res);
                if (code) payload.code = code;
                if (res.error === "invalid-params") {
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send(payload);
                if (res.error === "session-not-found") return reply.code(404).send(payload);
                return reply.code(500).send({ error: res.error });
            }

            const targetPendingState = request.params.runId ? res.targetPendingState : undefined;
            if (request.params.runId && !targetPendingState) {
                return reply.code(500).send({ error: "internal" });
            }
            return reply.send({ pending: res.pending.map(toPendingJson), ...(request.params.runId ? {
                recipient: { kind: "execution_run", runId: request.params.runId },
                ...targetPendingState,
            } : {}) });
        },
    );

    app.post(
        basePath,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string() }),
                body: executionRunTarget ? SessionExecutionRunPendingEnqueueRequestV1Schema : z.union([
                    z.object({
                        ciphertext: z.string().min(1),
                        localId: PendingLocalIdSchema,
                        messageRole: z.unknown().optional(),
                        deliveryMode: z.union([
                            z.literal("external_handoff"),
                            z.literal("continuation_if_no_queued_user_input"),
                        ]).optional(),
                        requestedAction: PendingRequestedActionV1Schema.optional(),
                        resumeWhenAvailable: z.literal(true).optional(),
                        targetMachineId: z.string().min(1).optional(),
                    }).strict(),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        localId: PendingLocalIdSchema,
                        messageRole: z.unknown().optional(),
                        deliveryMode: z.union([
                            z.literal("external_handoff"),
                            z.literal("continuation_if_no_queued_user_input"),
                        ]).optional(),
                        requestedAction: PendingRequestedActionV1Schema.optional(),
                        resumeWhenAvailable: z.literal(true).optional(),
                        targetMachineId: z.string().min(1).optional(),
                    }).strict(),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(!executionRunTarget ? { apiTokenSessionAction: "session.message.send" as const,
                    restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" } } : {}),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const targetBody = executionRunTarget ? SessionExecutionRunPendingEnqueueRequestV1Schema.safeParse(request.body) : null;
            if (targetBody && !targetBody.success) return reply.code(400).send({ error: "invalid-params" });
            const body = targetBody?.success ? targetBody.data : request.body as unknown;
            if (
                body
                && typeof body === "object"
                && Object.prototype.hasOwnProperty.call(body, "requestEqualityEvidenceV1")
            ) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            const localId =
                body && typeof body === "object" && "localId" in body && typeof (body as { localId?: unknown }).localId === "string"
                    ? (body as { localId: string }).localId
                    : "";
            // The reserved Agent-transition divider namespace is ENFORCED by the
            // shared Pending admission owner, which every adapter funnels
            // through. This early refusal is kept only because the account
            // adapter resolves session edit access before reaching that owner,
            // so deleting it would turn this 400 into a 403/404 for a caller
            // without edit access. It cannot disagree with the owner: same
            // protocol predicate, same `invalid-params` 400.
            if (isSessionAgentTransitionDividerLocalId(localId)) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;
            const requestedDeliveryMode = body && typeof body === "object" && "deliveryMode" in body
                ? (body as { deliveryMode?: unknown }).deliveryMode
                : undefined;
            const deliveryMode = requestedDeliveryMode === "external_handoff" ? "external_handoff" as const : undefined;
            const admissionMode = requestedDeliveryMode === "continuation_if_no_queued_user_input"
                ? "continuation_if_no_queued_user_input" as const
                : undefined;
            const requestedAction =
                body && typeof body === "object" && "requestedAction" in body
                    ? PendingRequestedActionV1Schema.parse((body as { requestedAction?: unknown }).requestedAction)
                    : PendingRequestedActionV1Schema.parse({ v: 1, kind: "enqueue" });
            const resumeWhenAvailable = body && typeof body === "object" && "resumeWhenAvailable" in body
                ? (body as { resumeWhenAvailable?: true }).resumeWhenAvailable
                : undefined;
            const targetMachineId = body && typeof body === 'object' && 'targetMachineId' in body
                && typeof body.targetMachineId === 'string' ? body.targetMachineId : undefined;
            const res = await (content
                ? enqueuePendingMessage({
                      actorUserId: request.userId,
                      authentication: readSessionAccessAuthenticationFromRequest(request),
                      sessionId,
                      ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                      localId,
                      ...(targetMachineId ? { targetMachineId } : {}),
                      content,
                      messageRole,
                      ...(deliveryMode ? { deliveryMode } : {}),
                      ...(admissionMode ? { admissionMode } : {}),
                      requestedAction,
                      ...(resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                      ...(typeof request.id === "string" ? { diagnosticCorrelationId: request.id } : {}),
                  })
                : enqueuePendingMessage({
                      actorUserId: request.userId,
                      authentication: readSessionAccessAuthenticationFromRequest(request),
                      sessionId,
                      ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                      localId,
                      ciphertext: ciphertext ?? "",
                      ...(targetMachineId ? { targetMachineId } : {}),
                      messageRole,
                      ...(deliveryMode ? { deliveryMode } : {}),
                      ...(admissionMode ? { admissionMode } : {}),
                      requestedAction,
                      ...(resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                      ...(typeof request.id === "string" ? { diagnosticCorrelationId: request.id } : {}),
                  }));

            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                const payload: { error: string; code?: string } = { error: res.error };
                const code = getOptionalErrorCode(res);
                if (code) payload.code = code;
                if (res.error === "invalid-params") {
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send(payload);
                if (res.error === "session-not-found") return reply.code(404).send(payload);
                if (res.error === "transaction-unavailable") return sendTransactionUnavailable(reply, res);
                return reply.code(500).send({ error: res.error });
            }

            if (res.suppressed === true) {
                return reply.send({
                    didWrite: false,
                    suppressed: true,
                    ...toPendingStateJson(res, request.params.runId),
                });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                meaningfulActivityAt: res.terminal === true ? undefined : res.meaningfulActivityAt,
                recipientCursors: res.recipientCursors,
                ...("activationTarget" in res && res.activationTarget
                    ? { activationTarget: res.activationTarget }
                    : {}),
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });

            return reply.send({
                didWrite: res.didWrite,
                ...(res.terminal === true
                    ? {
                        terminal: true as const,
                        message: serializePendingMaterializedMessage(res.message),
                    }
                    : { pending: toPendingJson(res.pending) }),
                ...(res.terminal === true
                    ? { requestedAction: res.message.requestedAction }
                    : res.pending.requestedAction
                        ? { requestedAction: res.pending.requestedAction }
                        : {}),
                ...toPendingStateJson(res, request.params.runId),
            });
        },
    );

    app.patch(
        `${basePath}/:localId/action`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: executionRunTarget
                    ? z.object({ requestedAction: PendingRequestedActionV1Schema }).strict()
                    : z.object({
                        requestedAction: PendingRequestedActionV1Schema,
                        resumeWhenAvailable: z.boolean().optional(),
                    }).strict(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(!executionRunTarget ? { apiTokenSessionAction: "session.message.send" as const,
                    restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" } } : {}),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await updatePendingRequestedAction({
                actorUserId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId,
                ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                localId,
                requestedAction: request.body.requestedAction,
                ...(!executionRunTarget
                    && "resumeWhenAvailable" in request.body
                    && typeof request.body.resumeWhenAvailable === "boolean"
                    ? { resumeWhenAvailable: request.body.resumeWhenAvailable }
                    : {}),
            });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "action-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "reset-start-unsupported") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            if (res.didUpdate) {
                await emitPendingChanged({
                    sessionId,
                    changedByAccountId: request.userId,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                    ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                    recipientCursors: res.recipientCursors,
                    ...(res.activationTarget ? { activationTarget: res.activationTarget } : {}),
                });
            }
            return reply.send({ ok: true, didUpdate: res.didUpdate, requestedAction: res.requestedAction, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    if (!executionRunTarget) app.post(
        `${basePath}/activation/fail`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string() }),
                body: PendingActivationFailureRequestV1Schema,
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const res = await markPendingActivationFailed({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                requestId: request.body.requestId,
                requestedAt: request.body.requestedAt,
                failureCode: request.body.failureCode,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }
            if (res.didFail) {
                await emitPendingChanged({
                    sessionId: request.params.sessionId,
                    changedByAccountId: request.userId,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                    recipientCursors: res.recipientCursors,
                });
            }
            return reply.send({ ok: true, didFail: res.didFail });
        },
    );

    app.patch(
        `${basePath}/:localId`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.union([
                    mutationBody({
                        ciphertext: z.string().min(1),
                        replacementLocalId: PendingLocalIdSchema.optional(),
                        replacementMutationFingerprint: PendingMessageMutationFingerprintV1Schema.optional(),
                        messageRole: z.unknown().optional(),
                    }),
                    mutationBody({
                        content: executionRunTarget ? StrictSessionStoredMessageContentEnvelopeSchema : SessionStoredMessageContentSchema,
                        replacementLocalId: PendingLocalIdSchema.optional(),
                        replacementMutationFingerprint: PendingMessageMutationFingerprintV1Schema.optional(),
                        messageRole: z.unknown().optional(),
                    }),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(!executionRunTarget ? { apiTokenSessionAction: "session.message.send" as const,
                    restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" } } : {}),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const body = request.body as unknown;
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;
            const replacementLocalId =
                body && typeof body === "object"
                    && "replacementLocalId" in body
                    && typeof (body as { replacementLocalId?: unknown }).replacementLocalId === "string"
                    ? (body as { replacementLocalId: string }).replacementLocalId
                    : undefined;
            const replacementMutationFingerprint =
                body && typeof body === "object"
                    && "replacementMutationFingerprint" in body
                    && typeof (body as { replacementMutationFingerprint?: unknown }).replacementMutationFingerprint === "string"
                    ? (body as { replacementMutationFingerprint: string }).replacementMutationFingerprint
                    : undefined;

            const res = await (content
                ? updatePendingMessage({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId, content, replacementLocalId, replacementMutationFingerprint, messageRole })
                : updatePendingMessage({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId, ciphertext: ciphertext ?? "", replacementLocalId, replacementMutationFingerprint, messageRole }));
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "local-id-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "pending-mutation-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                meaningfulActivityAt: res.meaningfulActivityAt,
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, localId: res.localId, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    for (const withdraw of [false, true]) app.route({
            method: withdraw ? 'POST' : 'DELETE',
            url: `${basePath}/:localId${withdraw ? '/withdraw' : ''}`,
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                ...(withdraw ? { body: z.object({}).strict() } : {}),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(withdraw || !executionRunTarget ? { apiTokenSessionAction: withdraw ? 'session.pending.withdraw' as const : "session.message.send" as const,
                    restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" } } : {}),
            },
        handler: async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await deletePendingMessage({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId,
                ...(withdraw ? { withdraw: true } : {}) });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                meaningfulActivityAt: res.meaningfulActivityAt,
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId), ...(withdraw && res.outcome ? { outcome: res.outcome } : {}) });
        },
    });

    app.post(
        `${basePath}/:localId/discard`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: mutationBody({ reason: z.string().optional() }).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
                ...(!executionRunTarget ? { apiTokenSessionAction: "session.message.send" as const,
                    restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" } } : {}),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const reason = request.body?.reason;

            const res = await discardPendingMessage({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId, reason });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                meaningfulActivityAt: res.meaningfulActivityAt,
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    app.post(
        `${basePath}/:localId/restore`,
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await restorePendingMessage({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                meaningfulActivityAt: res.meaningfulActivityAt,
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    app.post(
        `${basePath}/reorder`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string() }),
                body: mutationBody({ orderedLocalIds: z.array(z.string().min(1)).min(1) }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await reorderPendingMessages({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), orderedLocalIds: request.body.orderedLocalIds });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    if (!executionRunTarget) app.post(
        `${basePath}/:localId/delivery/block`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({ reason: PendingDeliveryBlockedReasonSchema }),
            },
            config: {
                restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await blockPendingDelivery({
                actorUserId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId,
                ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                localId,
                reason: request.body.reason,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    app.post(
        `${basePath}/:localId/delivery/dismiss`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: mutationBody({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await dismissPendingDelivery({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}), localId });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, didDismiss: res.didDismiss, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    app.post(
        `${basePath}/:localId/delivery/send-as-new`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: mutationBody({}),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await sendPendingDeliveryAsNew({
                actorUserId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId,
                ...(request.params.runId ? { targetExecutionRunId: request.params.runId } : {}),
                localId,
            });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict" || res.error === "identity-conflict") {
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                recipientCursors: res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, newLocalId: res.newLocalId, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    if (!executionRunTarget) app.post(
        `${basePath}/:localId/delivery/handled`,
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ runId, sessionId: z.string(), localId: PendingLocalIdSchema }) },
            config: {
                restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await markPendingDeliveryHandled({ actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), sessionId, localId });
            if (!res.ok) {
                const authenticationStatus = pendingAuthenticationStatus(res.error);
                if (authenticationStatus) return reply.code(authenticationStatus).send({ error: res.error });
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "transcript-conflict") {
                    if (res.pendingStateChanged === true) {
                        const recipientCursors = res.recipientCursors ?? [];
                        await emitPendingChanged({
                            sessionId,
                            changedByAccountId: request.userId,
                            pendingCount: res.pendingCount ?? 0,
                            pendingBlockedCount: res.pendingBlockedCount,
                            pendingVersion: res.pendingVersion ?? 0,
                            ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                            recipientCursors,
                        });
                        await refreshTrackedSessionAccountBadgePushes({
                            badgeAttentionChanged: res.badgeAttentionChanged ?? false,
                            sessionId,
                        });
                    }
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            await emitCommittedPendingDeliveryMessage({
                sessionId,
                message: res.message,
                eventKind: res.didUpdate === true && res.didWrite !== true ? "message-updated" : "new-message",
                recipientCursors: res.recipientCursorsMessage,
                readyProjection: res.readyProjection,
            });
            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(request.params.runId ? { recipient: { kind: "execution_run" as const, runId: request.params.runId } } : {}),
                recipientCursors: res.recipientCursorsPending ?? res.recipientCursors,
            });
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                sessionId,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res, request.params.runId) });
        },
    );

    if (!executionRunTarget) app.post(
        `${basePath}/materialize-next`,
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ runId, sessionId: z.string() }),
                body: z.object({
                    deliveryState: z.literal("provider").optional(),
                    deliveryTiming: z.enum(["after_foreground_ready", "after_runtime_idle"]).optional(),
                    foregroundState: z.enum(["ready", "active_steerable", "active_unsteerable"]).optional(),
                }).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (_request, reply) => {
            return reply.code(403).send({ error: "forbidden" });
        },
    );
}

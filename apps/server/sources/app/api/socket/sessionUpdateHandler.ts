import { sessionAliveEventsCounter, socketMessageAckCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import {
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildPendingChangedUpdate,
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { AsyncLock } from "@/utils/runtime/lock";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { Socket } from "socket.io";
import { applySessionReadCursorOperation, createSessionMessage, updateSessionAgentState, updateSessionMetadata } from "@/app/session/sessionWriteService";
import { recordSessionAlive } from "@/app/presence/presenceRecorder";
import { materializeNextPendingMessage } from "@/app/session/pending/pendingMessageService";
import { normalizeIncomingSessionMessageContent } from "@/app/session/messageContent/normalizeIncomingSessionMessageContent";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { parseIntEnv } from "@/config/env";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import { ExecutionRunPublicStateSchema } from "@happier-dev/protocol";
import { TranscriptStreamSegmentEphemeralMessageSchema } from "@happier-dev/protocol/updates";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { canPublishFromSessionScopedSocket } from "./sessionScopedBinding";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;
            const readCursorHintV1Raw = (data as any)?.readCursorHintV1;
            const lastViewedSessionSeqHint =
                typeof readCursorHintV1Raw?.lastViewedSessionSeq === "number" && Number.isFinite(readCursorHintV1Raw.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(readCursorHintV1Raw.lastViewedSessionSeq))
                    : null;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            const result = await updateSessionMetadata({
                actorUserId: userId,
                sessionId: sid,
                expectedVersion,
                metadataCiphertext: metadata,
                ...(typeof lastViewedSessionSeqHint === "number"
                    ? { readCursorHintV1: { lastViewedSessionSeq: lastViewedSessionSeqHint } }
                    : {}),
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                if (result.error === 'version-mismatch') {
                    if (!result.current) {
                        log({ module: 'websocket', level: 'error' }, `update-metadata version-mismatch without current state (sid=${sid})`);
                        callback?.({ result: 'error' });
                        return;
                    }
                    callback?.({ result: 'version-mismatch', version: result.current.version, metadata: result.current.metadata });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const metadataUpdate = { value: result.metadata, version: result.version };
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    metadataUpdate,
                    undefined,
                    typeof result.lastViewedSessionSeq === 'number'
                        ? { lastViewedSessionSeq: result.lastViewedSessionSeq }
                        : undefined,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });

            callback?.({ result: 'success', version: result.version, metadata: result.metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;
            const activitySummaryV1 = (data as any)?.activitySummaryV1;
            const pendingPermissionRequestCount =
                typeof activitySummaryV1?.pendingPermissionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingPermissionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingPermissionRequestCount))
                    : undefined;
            const pendingUserActionRequestCount =
                typeof activitySummaryV1?.pendingUserActionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingUserActionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingUserActionRequestCount))
                    : undefined;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            const result = await updateSessionAgentState({
                actorUserId: userId,
                sessionId: sid,
                expectedVersion,
                agentStateCiphertext: agentState,
                ...(typeof pendingPermissionRequestCount === "number" ? { pendingPermissionRequestCount } : {}),
                ...(typeof pendingUserActionRequestCount === "number" ? { pendingUserActionRequestCount } : {}),
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                if (result.error === 'version-mismatch') {
                    if (!result.current) {
                        log({ module: 'websocket', level: 'error' }, `update-state version-mismatch without current state (sid=${sid})`);
                        callback?.({ result: 'error' });
                        return;
                    }
                    callback?.({ result: 'version-mismatch', version: result.current.version, agentState: result.current.agentState });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const agentStateUpdate = { value: result.agentState, version: result.version };
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    agentStateUpdate,
                    (
                        typeof result.pendingPermissionRequestCount === 'number'
                        || typeof result.pendingUserActionRequestCount === 'number'
                    )
                        ? {
                            ...(typeof result.pendingPermissionRequestCount === 'number'
                                ? { pendingPermissionRequestCount: result.pendingPermissionRequestCount }
                                : {}),
                            ...(typeof result.pendingUserActionRequestCount === 'number'
                                ? { pendingUserActionRequestCount: result.pendingUserActionRequestCount }
                                : {}),
                        }
                        : undefined,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });

            callback?.({ result: 'success', version: result.version, agentState: result.agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('update-read-cursor', async (data: any, callback: (response: any) => void) => {
        try {
            const sid = typeof data?.sid === 'string' ? data.sid : '';
            const operationRaw = data?.operation;
            const hasOperation = operationRaw !== undefined;
            const manualOperation =
                operationRaw === "mark-read" || operationRaw === "mark-unread"
                    ? { kind: operationRaw }
                    : null;
            const lastViewedSessionSeq =
                !hasOperation && typeof data?.lastViewedSessionSeq === 'number' && Number.isFinite(data.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(data.lastViewedSessionSeq))
                    : null;

            if (!sid || (hasOperation && !manualOperation) || (!manualOperation && typeof lastViewedSessionSeq !== "number")) {
                callback?.({ result: 'error' });
                return;
            }

            const operation = (() => {
                if (manualOperation) {
                    return manualOperation;
                }
                if (typeof lastViewedSessionSeq !== "number") {
                    return null;
                }
                return { kind: "advance" as const, lastViewedSessionSeq };
            })();
            if (!operation) {
                callback?.({ result: 'error' });
                return;
            }
            const result = await applySessionReadCursorOperation({
                actorUserId: userId,
                sessionId: sid,
                operation,
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            await publishSessionReadCursorUpdate({
                sessionId: sid,
                lastViewedSessionSeq: result.lastViewedSessionSeq,
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
                skipSenderConnection: connection,
                skipSenderAccountId: userId,
            });

            callback?.({
                result: 'success',
                ...(typeof result.lastViewedSessionSeq === "number" ? { lastViewedSessionSeq: result.lastViewedSessionSeq } : {}),
                ...(manualOperation ? { didChange: result.didChange, readState: result.readState } : {}),
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-read-cursor: ${error}`);
            callback?.({ result: 'error' });
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive' });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            await recordSessionAlive({ accountId: userId, sessionId: sid, timestamp: t });

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    socket.on('execution-run-updated', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'execution-run-updated' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            const runRaw = data?.run;
            if (!sid) return;

            if (!await canPublishFromSessionScopedSocket({
                socket,
                connection,
                sessionId: sid,
                requireMachineBinding: true,
            })) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access) return;
            if (!requireAccessLevel(access, 'edit')) {
                return;
            }
            if (!access.isOwner) {
                return;
            }

            // Strip unknown fields before rebroadcasting (clients treat this as a hint; keep the payload tight).
            const parsedRun = ExecutionRunPublicStateSchema.strip().safeParse(runRaw);
            if (!parsedRun.success) {
                return;
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId: sid });
            if (!participantUserIds || participantUserIds.length === 0) return;

            const payload = {
                type: 'execution-run-updated' as const,
                sessionId: sid,
                run: parsedRun.data,
            };

            // Broadcast to all participants. Execution runs are a UI optimization; clients must still treat this as a hint.
            for (const participantUserId of participantUserIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in execution-run-updated handler: ${error}`);
        }
    });

    socket.on('transcript-stream-segment', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'transcript-stream-segment' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            if (!sid) return;

            if (!await canPublishFromSessionScopedSocket({
                socket,
                connection,
                sessionId: sid,
                requireMachineBinding: true,
            })) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access) return;
            if (!requireAccessLevel(access, 'edit')) {
                return;
            }
            if (!access.isOwner) {
                return;
            }

            const parsedMessage = TranscriptStreamSegmentEphemeralMessageSchema.strip().safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId: sid });
            if (!participantUserIds || participantUserIds.length === 0) return;

            const payload = {
                type: 'transcript-stream-segment' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of participantUserIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in transcript-stream-segment handler: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: any) => {
                if (typeof callback === 'function') {
                    callback(response);
                }
            };

            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const sid = typeof data?.sid === 'string' ? data.sid : null;
                const content = normalizeIncomingSessionMessageContent(data?.message);
                const localId = typeof data?.localId === 'string' ? data.localId : null;
                const echoToSender = data?.echoToSender === true;
                const parsedSidechainId = parseSessionMessageSidechainId(data?.sidechainId, { emptyString: "invalid" });
                if (!parsedSidechainId.ok) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }
                const sidechainId = parsedSidechainId.sidechainId;

                if (!sid || !content) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                const loggedLength = (() => {
                    if (content.t === "encrypted") return content.c.length;
                    try {
                        return JSON.stringify(content.v ?? null).length;
                    } catch {
                        return 0;
                    }
                })();
                log(
                    { module: 'websocket' },
                    `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${loggedLength} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`
                );

                const result = await createSessionMessage({
                    actorUserId: userId,
                    sessionId: sid,
                    content,
                    localId,
                    sidechainId,
                });

                if (!result.ok) {
                    socketMessageAckCounter.inc({ result: 'error', error: result.error });
                    respond({ ok: false, error: result.error });
                    return;
                }

                socketMessageAckCounter.inc({ result: 'ok', error: 'none' });
                respond({
                    ok: true,
                    id: result.message.id,
                    seq: result.message.seq,
                    localId: result.message.localId,
                    didWrite: result.didWrite,
                    ...(result.didUpdate ? { didUpdate: true } : {}),
                });

                if (!result.didWrite && !result.didUpdate) {
                    return;
                }

                await Promise.all(result.participantCursors.map(async ({ accountId: participantUserId, cursor }) => {
                    const payload = result.didWrite
                        ? buildNewMessageUpdate(result.message, sid, cursor, randomKeyNaked(12))
                        : buildMessageUpdatedUpdate(result.message, sid, cursor, randomKeyNaked(12));
                    eventRouter.emitUpdate({
                        userId: participantUserId,
                        payload,
                        recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        skipSenderConnection: participantUserId === userId && !echoToSender ? connection : undefined,
                    });
                }));
                await refreshSessionParticipantBadgePushes({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    participantCursors: result.participantCursors,
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
                socketMessageAckCounter.inc({ result: 'error', error: 'internal' });
                respond({ ok: false, error: 'internal' });
            }
        });
    });

    socket.on('pending-materialize-next', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: any) => {
                if (typeof callback === 'function') {
                    callback(response);
                }
            };

            try {
                const sid = typeof data?.sid === 'string' ? data.sid : null;
                if (!sid) {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                if (connection.connectionType === 'session-scoped' && connection.sessionId && connection.sessionId !== sid) {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                const result = await materializeNextPendingMessage({
                    actorUserId: userId,
                    sessionId: sid,
                });

                if (!result.ok) {
                    respond({ ok: false, error: result.error });
                    return;
                }

                if (!result.didMaterialize) {
                    respond({ ok: true, didMaterialize: false });
                    return;
                }

                respond({
                    ok: true,
                    didMaterialize: true,
                    didWrite: result.didWriteMessage,
                    message: { id: result.message.id, seq: result.message.seq, localId: result.message.localId },
                });

                if (result.didWriteMessage) {
                    await Promise.all(
                        result.participantCursorsMessage.map(async ({ accountId, cursor }) => {
                            const payload = buildNewMessageUpdate(result.message, sid, cursor, randomKeyNaked(12));
                            eventRouter.emitUpdate({
                                userId: accountId,
                                payload,
                                recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                            });
                        }),
                    );
                }

                await Promise.all(
                    result.participantCursorsPending.map(async ({ accountId, cursor }) => {
                        const payload = buildPendingChangedUpdate(
                            { sessionId: sid, pendingCount: result.pendingCount, pendingVersion: result.pendingVersion, changedByAccountId: userId },
                            cursor,
                            randomKeyNaked(12),
                        );
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload,
                            recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        });
                    }),
                );
                await refreshSessionParticipantBadgePushes({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    participantCursors: [...result.participantCursorsMessage, ...result.participantCursorsPending],
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in pending-materialize-next: ${error}`);
                respond({ ok: false, error: 'internal' });
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId },
                select: {
                    id: true,
                    seq: true,
                    pendingCount: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });
            if (!session) {
                return;
            }

            activityCache.markSessionInactive(sid, userId, t);

            // Update last active at
            await db.session.update({
                where: { id: sid },
                data: { lastActiveAt: new Date(t), active: false }
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(session, {
                    ...session,
                    active: false,
                }),
                participantCursors: [{ accountId: userId }],
            });

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}

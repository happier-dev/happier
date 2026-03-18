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
import { createSessionMessage, updateSessionAgentState, updateSessionMetadata, updateSessionReadCursor } from "@/app/session/sessionWriteService";
import { recordSessionAlive } from "@/app/presence/presenceRecorder";
import { materializeNextPendingMessage } from "@/app/session/pending/pendingMessageService";
import { normalizeIncomingSessionMessageContent } from "@/app/session/messageContent/normalizeIncomingSessionMessageContent";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { parseIntEnv } from "@/config/env";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import { ExecutionRunPublicStateSchema } from "@happier-dev/protocol";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { canPublishFromSessionScopedSocket } from "./sessionScopedBinding";

const DEFAULT_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_TTL_MS = 5_000;
const DEFAULT_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_MAX_ENTRIES = 200;
const DEFAULT_TRANSCRIPT_DRAFT_CREATED_AT_MAX_SKEW_MS = 60_000;
const DEFAULT_TRANSCRIPT_DRAFT_MAX_BYTES = 64 * 1024;

function resolveTranscriptDraftParticipantsCacheTtlMs(): number {
    return parseIntEnv(
        process.env.HAPPIER_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_TTL_MS,
        DEFAULT_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_TTL_MS,
        { min: 0 },
    );
}

function resolveTranscriptDraftParticipantsCacheMaxEntries(): number {
    return parseIntEnv(
        process.env.HAPPIER_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_MAX_ENTRIES,
        DEFAULT_TRANSCRIPT_DRAFT_PARTICIPANTS_CACHE_MAX_ENTRIES,
        { min: 1 },
    );
}

function resolveTranscriptDraftCreatedAtMaxSkewMs(): number {
    return parseIntEnv(
        process.env.HAPPIER_TRANSCRIPT_DRAFT_CREATED_AT_MAX_SKEW_MS,
        DEFAULT_TRANSCRIPT_DRAFT_CREATED_AT_MAX_SKEW_MS,
        { min: 0 },
    );
}

function resolveTranscriptDraftMaxBytes(): number {
    return parseIntEnv(process.env.HAPPIER_TRANSCRIPT_DRAFT_MAX_BYTES, DEFAULT_TRANSCRIPT_DRAFT_MAX_BYTES, { min: 1 });
}

type TranscriptDraftParticipantsCacheEntry = Readonly<{
    userIds: string[];
    sessionEncryptionMode: "e2ee" | "plain";
    expiresAtMs: number;
}>;

const transcriptDraftParticipantsCache = new Map<string, TranscriptDraftParticipantsCacheEntry>();

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
            const lastViewedSessionSeq =
                typeof data?.lastViewedSessionSeq === 'number' && Number.isFinite(data.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(data.lastViewedSessionSeq))
                    : NaN;

            if (!sid || !Number.isFinite(lastViewedSessionSeq)) {
                callback?.({ result: 'error' });
                return;
            }

            const result = await updateSessionReadCursor({
                actorUserId: userId,
                sessionId: sid,
                lastViewedSessionSeq,
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    { lastViewedSessionSeq: result.lastViewedSessionSeq },
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

            callback?.({ result: 'success', lastViewedSessionSeq: result.lastViewedSessionSeq });
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

            if (!canPublishFromSessionScopedSocket({
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

    socket.on('transcript-draft', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'transcript-draft' });

            const sid = typeof data?.sid === 'string' ? data.sid : null;
            const localId = typeof data?.localId === 'string' ? data.localId.trim() : '';
            const segmentKind = data?.segmentKind === 'assistant' || data?.segmentKind === 'thinking' ? data.segmentKind : null;
            const parsedSidechainId = parseSessionMessageSidechainId(data?.sidechainId, { emptyString: "invalid" });
            const sidechainId = parsedSidechainId.ok ? parsedSidechainId.sidechainId : '';
            const delta = normalizeIncomingSessionMessageContent(data?.delta);

            if (!sid || !localId || !segmentKind || sidechainId === '' || !delta) {
                return;
            }

            if (connection.connectionType === 'session-scoped' && connection.sessionId && connection.sessionId !== sid) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access || !requireAccessLevel(access, 'edit')) {
                return;
            }

            const nowMs = Date.now();
            const createdAtRaw = data?.createdAt;
            const createdAtUnclamped =
                typeof createdAtRaw === 'number' && Number.isFinite(createdAtRaw) && createdAtRaw >= 0 ? Math.trunc(createdAtRaw) : nowMs;
            const maxSkewMs = resolveTranscriptDraftCreatedAtMaxSkewMs();
            const createdAt = Math.min(nowMs + maxSkewMs, Math.max(nowMs - maxSkewMs, createdAtUnclamped));
            const ttlMs = resolveTranscriptDraftParticipantsCacheTtlMs();
            const cached = transcriptDraftParticipantsCache.get(sid);
            const cacheEntry =
                cached && cached.expiresAtMs > nowMs
                    ? cached
                    : await (async (): Promise<TranscriptDraftParticipantsCacheEntry | null> => {
                        const [userIds, session] = await Promise.all([
                            getSessionParticipantUserIds({ sessionId: sid }),
                            db.session.findUnique({ where: { id: sid }, select: { encryptionMode: true } }),
                        ]);
                        if (!session) return null;
                        const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
                        const entry: TranscriptDraftParticipantsCacheEntry = {
                            userIds,
                            sessionEncryptionMode,
                            expiresAtMs: nowMs + ttlMs,
                        };
                        transcriptDraftParticipantsCache.set(sid, entry);
                        const maxEntries = resolveTranscriptDraftParticipantsCacheMaxEntries();
                        while (transcriptDraftParticipantsCache.size > maxEntries) {
                            const oldestKey = transcriptDraftParticipantsCache.keys().next().value as string | undefined;
                            if (!oldestKey) break;
                            transcriptDraftParticipantsCache.delete(oldestKey);
                        }
                        return entry;
                    })();

            if (!cacheEntry) {
                return;
            }

            const expectedDeltaKind = cacheEntry.sessionEncryptionMode === "plain" ? "plain" : "encrypted";
            if (delta.t !== expectedDeltaKind) {
                return;
            }

            const maxBytes = resolveTranscriptDraftMaxBytes();
            const deltaLength = (() => {
                if (delta.t === "encrypted") return Buffer.byteLength(delta.c, "utf8");
                try {
                    return Buffer.byteLength(JSON.stringify(delta.v ?? null), "utf8");
                } catch {
                    // Fail closed: if we cannot reliably size the payload, do not relay it.
                    return maxBytes + 1;
                }
            })();
            if (deltaLength > maxBytes) {
                return;
            }

            const payload = {
                type: 'transcript-draft' as const,
                sessionId: sid,
                localId,
                segmentKind,
                sidechainId,
                delta,
                createdAt,
            };

            for (const participantUserId of cacheEntry.userIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in transcript-draft handler: ${error}`);
        }
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

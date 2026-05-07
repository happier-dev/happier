import type { NormalizedMessage } from '@/sync/typesRaw';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

type SocketMessageTelemetryFields = Readonly<{
    encrypted: number;
    plain: number;
    newMessage: number;
    messageUpdated: number;
    sessionKnown: number;
}>;

function buildSocketMessageTelemetryFields(params: Readonly<{
    message: any;
    inferLifecycle: boolean;
    session: Session | undefined;
}>): SocketMessageTelemetryFields | undefined {
    if (!syncPerformanceTelemetry.isEnabled()) return undefined;
    return {
        encrypted: params.message?.content?.t === 'encrypted' ? 1 : 0,
        plain: params.message?.content?.t === 'plain' ? 1 : 0,
        newMessage: params.inferLifecycle ? 1 : 0,
        messageUpdated: params.inferLifecycle ? 0 : 1,
        sessionKnown: params.session ? 1 : 0,
    };
}

function inferTaskLifecycleFromMessageContent(content: unknown, createdAt: number): {
    isTaskComplete: boolean;
    isTaskStarted: boolean;
    lifecycleEvent: TaskLifecycleEvent | null;
} {
    const lifecycleEvent = getTaskLifecycleEventFromRawContent(content, createdAt);
    const isTaskComplete = lifecycleEvent?.type === 'task_complete' || lifecycleEvent?.type === 'turn_aborted';
    const isTaskStarted = lifecycleEvent?.type === 'task_started';

    return { isTaskComplete, isTaskStarted, lifecycleEvent };
}

type HandleSessionMessageSocketUpdateParams = {
    updateData: any;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    enqueueMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
    onNormalizedMessagesApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
    isMutableToolCall: (sessionId: string, toolUseId: string) => boolean;
    invalidateScmStatus: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    onTaskLifecycleEvent?: (sessionId: string, event: TaskLifecycleEvent) => void;
};

async function handleSessionMessageSocketUpdate(params: HandleSessionMessageSocketUpdateParams & {
    inferLifecycle: boolean;
}): Promise<void> {
    const {
        updateData,
        getSessionEncryption,
        getSession,
        applySessions,
        fetchSessions,
        applyMessages,
        enqueueMessages,
        isMutableToolCall,
        invalidateScmStatus,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        inferLifecycle,
    } = params;

    const body = updateData?.body;
    if (!body || typeof body !== 'object') {
        return;
    }

    const sessionId = (body as any).sid as string;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return;
    }

    const messageSeq = (body as any).message?.seq;
    const prevMaterializedMaxSeq = getSessionMaterializedMaxSeq(sessionId);
    if (
        inferLifecycle
        && typeof messageSeq === 'number'
        && Number.isFinite(messageSeq)
        && prevMaterializedMaxSeq >= Math.trunc(messageSeq)
        && isSessionMessagesLoaded(sessionId)
    ) {
        syncPerformanceTelemetry.count('sync.sessions.socket.newMessage.replaySkipped', {
            prevMaterializedMaxSeq,
            messageSeq: Math.trunc(messageSeq),
        });
        return;
    }

    const session = getSession(sessionId);
    const expectsEncryptedMessages = session?.encryptionMode !== 'plain';
    const encryption = expectsEncryptedMessages ? getSessionEncryption(sessionId) : null;
    if (!encryption && expectsEncryptedMessages && session) {
        console.error(`Session encryption not found for ${sessionId} - this should never happen`);
    }

    const rawMessage = 'message' in body
        ? (body as { message?: ApiMessage }).message
        : undefined;
    const telemetryFields = buildSocketMessageTelemetryFields({
        message: rawMessage,
        inferLifecycle,
        session,
    });

    let lastMessage: NormalizedMessage | null = null;
    if (rawMessage) {
        const readMessage = () => readStoredSessionMessage({
            message: rawMessage,
            decryptMessage: encryption ? (message) => encryption.decryptMessage(message) : undefined,
        });
        const decrypted = telemetryFields
            ? await syncPerformanceTelemetry.measureAsync(
                'sync.sessions.socket.message.readMessage',
                telemetryFields,
                readMessage,
            )
            : await readMessage();
        const sessionAfterRead = session ? getSession(sessionId) : undefined;
        if (session && !sessionAfterRead) {
            return;
        }
        const sessionForApply = sessionAfterRead ?? session;
        if (decrypted) {
            const normalizedSeq =
                typeof messageSeq === 'number' && Number.isFinite(messageSeq)
                    ? Math.trunc(messageSeq)
                    : (
                        typeof decrypted.seq === 'number' && Number.isFinite(decrypted.seq)
                            ? Math.trunc(decrypted.seq)
                            : undefined
                    );
            const normalizeMessage = () => normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: normalizedSeq });
            lastMessage = telemetryFields
                ? syncPerformanceTelemetry.measure(
                    'sync.sessions.socket.message.normalize',
                    {
                        ...telemetryFields,
                        seqKnown: typeof normalizedSeq === 'number' ? 1 : 0,
                    },
                    normalizeMessage,
                )
                : normalizeMessage();

            const { isTaskComplete, isTaskStarted, lifecycleEvent } = inferLifecycle
                ? inferTaskLifecycleFromMessageContent(decrypted.content, decrypted.createdAt)
                : { isTaskComplete: false, isTaskStarted: false, lifecycleEvent: null };
            if (lifecycleEvent) {
                params.onTaskLifecycleEvent?.(sessionId, lifecycleEvent);
            }

            if (sessionForApply) {
                const nextSessionSeq = computeNextSessionSeqFromUpdate({
                    currentSessionSeq: sessionForApply.seq ?? 0,
                    updateType: 'new-message',
                    containerSeq: updateData.seq,
                    messageSeq: (body as any).message?.seq,
                });

                const nextSession = {
                    ...sessionForApply,
                    updatedAt: updateData.createdAt,
                    seq: nextSessionSeq,
                    ...(inferLifecycle && isTaskComplete ? { thinking: false } : {}),
                    ...(inferLifecycle && isTaskStarted ? { thinking: true } : {}),
                };
                const applySession = () => applySessions([
                    {
                        ...sessionForApply,
                        ...nextSession,
                    },
                ]);
                if (telemetryFields) {
                    syncPerformanceTelemetry.measure(
                        'sync.sessions.socket.message.applySession',
                        {
                            ...telemetryFields,
                            sessions: 1,
                            taskStarted: isTaskStarted ? 1 : 0,
                            taskComplete: isTaskComplete ? 1 : 0,
                        },
                        applySession,
                    );
                } else {
                    applySession();
                }
            } else {
                fetchSessions();
            }

            if (lastMessage) {
                const normalizedMessage = lastMessage;
                if (enqueueMessages) {
                    enqueueMessages(sessionId, [normalizedMessage]);
                    if (telemetryFields) {
                        syncPerformanceTelemetry.count('sync.sessions.socket.message.apply', {
                            ...telemetryFields,
                            normalized: 1,
                            queued: 1,
                            direct: 0,
                        });
                    }
                } else {
                    const applyMessage = () => {
                        applyMessages(sessionId, [normalizedMessage]);
                    };
                    if (telemetryFields) {
                        syncPerformanceTelemetry.measure(
                            'sync.sessions.socket.message.apply',
                            {
                                ...telemetryFields,
                                normalized: 1,
                                queued: 0,
                                direct: 1,
                            },
                            applyMessage,
                        );
                    } else {
                        applyMessage();
                    }
                    params.onNormalizedMessagesApplied?.(sessionId, [normalizedMessage]);
                    if (typeof messageSeq === 'number') {
                        markSessionMaterializedMaxSeq(sessionId, messageSeq);
                    }
                }

                let hasMutableTool = false;
                if (!enqueueMessages) {
                    markStreamingMessagesAppliedForSessionUiTelemetry({
                        sessionId,
                        messages: [normalizedMessage],
                        source: 'socketMessage',
                    });
                }
                if (
                    lastMessage.role === 'agent' &&
                    Array.isArray(lastMessage.content) &&
                    lastMessage.content.length > 0 &&
                    lastMessage.content[0] &&
                    (lastMessage.content[0] as any).type === 'tool-result'
                ) {
                    hasMutableTool = isMutableToolCall(sessionId, (lastMessage.content[0] as any).tool_use_id);
                }
                if (hasMutableTool) {
                    invalidateScmStatus(sessionId);
                }
            }

            if (
                typeof messageSeq === 'number' &&
                prevMaterializedMaxSeq > 0 &&
                messageSeq > prevMaterializedMaxSeq + 1 &&
                isSessionMessagesLoaded(sessionId)
            ) {
                onMessageGapDetected(sessionId, { prevMaterializedMaxSeq, messageSeq });
            }
        } else {
            if (!sessionForApply) {
                fetchSessions();
            } else if (isSessionMessagesLoaded(sessionId)) {
                onMessageGapDetected(sessionId, { prevMaterializedMaxSeq, messageSeq: typeof messageSeq === 'number' ? messageSeq : null });
            } else {
                fetchSessions();
            }
        }
    }
}

export async function handleNewMessageSocketUpdate(params: HandleSessionMessageSocketUpdateParams): Promise<void> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.newMessage',
        { hasMessage: params.updateData?.body?.message ? 1 : 0 },
        async () => handleSessionMessageSocketUpdate({ ...params, inferLifecycle: true }),
    );
}

export async function handleMessageUpdatedSocketUpdate(params: HandleSessionMessageSocketUpdateParams): Promise<void> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.messageUpdated',
        { hasMessage: params.updateData?.body?.message ? 1 : 0 },
        async () => handleSessionMessageSocketUpdate({ ...params, inferLifecycle: false }),
    );
}

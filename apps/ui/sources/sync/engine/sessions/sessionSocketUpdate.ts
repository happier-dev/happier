import type { NormalizedMessage } from '@/sync/typesRaw';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

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
    const session = getSession(sessionId);
    const encryption = getSessionEncryption(sessionId);
    const expectsEncryptedMessages = session?.encryptionMode !== 'plain';
    if (!encryption && expectsEncryptedMessages && session) {
        console.error(`Session encryption not found for ${sessionId} - this should never happen`);
    }

    let lastMessage: NormalizedMessage | null = null;
    if ((body as any).message) {
        const decrypted = await readStoredSessionMessage({
            message: (body as any).message,
            decryptMessage: encryption ? (message) => encryption.decryptMessage(message) : undefined,
        });
        if (decrypted) {
            const normalizedSeq =
                typeof messageSeq === 'number' && Number.isFinite(messageSeq)
                    ? Math.trunc(messageSeq)
                    : (
                        typeof decrypted.seq === 'number' && Number.isFinite(decrypted.seq)
                            ? Math.trunc(decrypted.seq)
                            : undefined
                    );
            lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: normalizedSeq });

            const { isTaskComplete, isTaskStarted, lifecycleEvent } = inferLifecycle
                ? inferTaskLifecycleFromMessageContent(decrypted.content, decrypted.createdAt)
                : { isTaskComplete: false, isTaskStarted: false, lifecycleEvent: null };
            if (lifecycleEvent) {
                params.onTaskLifecycleEvent?.(sessionId, lifecycleEvent);
            }

            if (session) {
                const nextSessionSeq = computeNextSessionSeqFromUpdate({
                    currentSessionSeq: session.seq ?? 0,
                    updateType: 'new-message',
                    containerSeq: updateData.seq,
                    messageSeq: (body as any).message?.seq,
                });

                applySessions([
                    {
                        ...session,
                        updatedAt: updateData.createdAt,
                        seq: nextSessionSeq,
                        ...(inferLifecycle && isTaskComplete ? { thinking: false } : {}),
                        ...(inferLifecycle && isTaskStarted ? { thinking: true } : {}),
                    },
                ]);
            } else {
                fetchSessions();
            }

            if (lastMessage) {
                if (enqueueMessages) {
                    enqueueMessages(sessionId, [lastMessage]);
                } else {
                    applyMessages(sessionId, [lastMessage]);
                    params.onNormalizedMessagesApplied?.(sessionId, [lastMessage]);
                    if (typeof messageSeq === 'number') {
                        markSessionMaterializedMaxSeq(sessionId, messageSeq);
                    }
                }

                let hasMutableTool = false;
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
            if (!session) {
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
    return handleSessionMessageSocketUpdate({ ...params, inferLifecycle: true });
}

export async function handleMessageUpdatedSocketUpdate(params: HandleSessionMessageSocketUpdateParams): Promise<void> {
    return handleSessionMessageSocketUpdate({ ...params, inferLifecycle: false });
}

import type { NormalizedMessage } from '../typesRaw';
import { normalizeRawMessage } from '../typesRaw';
import { computeNextSessionSeqFromUpdate } from '../realtimeSessionSeq';
import type { Session } from '../storageTypes';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

function inferTaskLifecycleFromMessageContent(content: unknown): { isTaskComplete: boolean; isTaskStarted: boolean } {
    const rawContent = content as { content?: { type?: string; data?: { type?: string } } } | null;
    const contentType = rawContent?.content?.type;
    const dataType = rawContent?.content?.data?.type;

    const isTaskComplete =
        (contentType === 'acp' || contentType === 'codex') &&
        (dataType === 'task_complete' || dataType === 'turn_aborted');

    const isTaskStarted = (contentType === 'acp' || contentType === 'codex') && dataType === 'task_started';

    return { isTaskComplete, isTaskStarted };
}

export async function handleNewMessageSocketUpdate(params: {
    updateData: any;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    isMutableToolCall: (sessionId: string, toolUseId: string) => boolean;
    invalidateGitStatus: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    invalidateMessagesForSession: (sessionId: string) => void;
}): Promise<void> {
    const {
        updateData,
        getSessionEncryption,
        getSession,
        applySessions,
        fetchSessions,
        applyMessages,
        isMutableToolCall,
        invalidateGitStatus,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        invalidateMessagesForSession,
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

    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        console.error(`Session ${sessionId} not found`);
        fetchSessions();
        return;
    }

    let lastMessage: NormalizedMessage | null = null;
    if ((body as any).message) {
        const decrypted = await encryption.decryptMessage((body as any).message);
        if (decrypted) {
            lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);

            const { isTaskComplete, isTaskStarted } = inferTaskLifecycleFromMessageContent(decrypted.content);

            const session = getSession(sessionId);
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
                        ...(isTaskComplete ? { thinking: false } : {}),
                        ...(isTaskStarted ? { thinking: true } : {}),
                    },
                ]);
            } else {
                fetchSessions();
            }

            if (lastMessage) {
                applyMessages(sessionId, [lastMessage]);
                if (typeof messageSeq === 'number') {
                    markSessionMaterializedMaxSeq(sessionId, messageSeq);
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
                    invalidateGitStatus(sessionId);
                }
            }

            if (
                typeof messageSeq === 'number' &&
                prevMaterializedMaxSeq > 0 &&
                messageSeq > prevMaterializedMaxSeq + 1 &&
                isSessionMessagesLoaded(sessionId)
            ) {
                invalidateMessagesForSession(sessionId);
            }
        } else {
            if (isSessionMessagesLoaded(sessionId)) {
                invalidateMessagesForSession(sessionId);
            } else {
                fetchSessions();
            }
        }
    }
}

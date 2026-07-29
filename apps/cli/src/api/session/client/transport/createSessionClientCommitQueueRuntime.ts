import { logger } from '@/ui/logger';

import { encodeBase64, encrypt } from '../../../encryption';
import { MessageAckResponseSchema, type ClientToServerEvents, type ServerToClientEvents } from '../../../types';
import type { Socket } from 'socket.io-client';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { deliverRequiredDirectSessionMessageViaHttp } from './deliverRequiredDirectSessionMessageViaHttp';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

type QueuedDisconnectedSessionMessage = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    retryToken?: CommitRetryToken;
}>;

type CommitSessionMessageParams = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    requireCommit: boolean;
    markAsUserMessage?: boolean;
    refreshAgentQueueEchoSuppression?: boolean;
}>;

type CommitRetryToken = Readonly<{ localId: string; generation: number }>;
type CommitRetryRecord = {
    generation: number;
    params: CommitSessionMessageParams;
    attempts: number;
    timer: ReturnType<typeof setTimeout> | null;
    timerEpoch: number;
};

export class DefinitiveSessionMessageCommitError extends Error {
    readonly definitiveSessionMessageCommitFailure = true;

    constructor(message: string) {
        super(message);
        this.name = 'DefinitiveSessionMessageCommitError';
    }
}

export function isDefinitiveSessionMessageCommitError(
    error: unknown,
): error is DefinitiveSessionMessageCommitError {
    return error instanceof DefinitiveSessionMessageCommitError
        || (
            typeof error === 'object'
            && error !== null
            && 'definitiveSessionMessageCommitFailure' in error
            && (error as { definitiveSessionMessageCommitFailure?: unknown }).definitiveSessionMessageCommitFailure === true
        );
}

export type SessionClientCommitQueueRuntime = Readonly<{
    readonly queuedDisconnectedSessionMessages: ReadonlyMap<string, QueuedDisconnectedSessionMessage>;
    getMessageCommitQueueTail: () => Promise<unknown>;
    enqueueMessageCommit: <T>(fn: () => Promise<T>) => Promise<T>;
    queueSessionMessageUntilReconnect: (params: QueuedDisconnectedSessionMessage) => void;
    flushQueuedSessionMessagesOnReconnect: () => Promise<void>;
    buildOutboundSessionMessagePayload: (content: unknown) => PlainOrEncryptedPayload;
    commitSessionMessage: (params: CommitSessionMessageParams) => Promise<void>;
    commitSessionMessageBestEffort: (params: Readonly<{
        message: PlainOrEncryptedPayload;
        localId: string;
        sidechainId: string | null;
        logErrorMessage: string;
        messageRole: SessionMessageRole;
        sessionEventType?: SessionEventType;
        markAsUserMessage?: boolean;
        refreshAgentQueueEchoSuppression?: boolean;
    }>) => Promise<void>;
    clearState: () => void;
}>;

export function createSessionClientCommitQueueRuntime(
    deps: Readonly<{
        token: string;
        sessionId: string;
        transcriptStorage: 'persisted' | 'direct';
        sessionEncryptionMode: 'e2ee' | 'plain';
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
        getSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getClosed: () => boolean;
        addPendingMaterializedLocalId: (localId: string) => void;
        hasPendingMaterializedLocalId: (localId: string) => boolean;
        markCommittedLocalIdAwaitingEcho: (localId: string) => void;
        deleteMaterializedLocalId: (localId: string) => void;
        observeCommittedAck: (params: { seq: number; localId?: string | null; markAsUserMessage?: boolean; refreshAgentQueueEchoSuppression?: boolean }) => void;
        requestReconnect?: (localId: string) => void;
    }>,
): SessionClientCommitQueueRuntime {
    const queuedDisconnectedSessionMessages = new Map<string, QueuedDisconnectedSessionMessage>();
    const commitRetryByLocalId = new Map<string, CommitRetryRecord>();
    let nextRetryGeneration = 1;
    let retryDisposed = false;
    let messageCommitQueueTail: Promise<unknown> = Promise.resolve();

    const emitSessionMessageWithAck = async (
        params: Readonly<{
            message: PlainOrEncryptedPayload;
            localId: string;
            sidechainId: string | null;
            messageRole: SessionMessageRole;
            sessionEventType?: SessionEventType;
        }>,
    ) => {
        try {
            const raw = await emitSocketWithAck({
                socket: deps.getSocket() as any,
                event: 'message',
                payload: {
                    sid: deps.sessionId,
                    message: params.message,
                    localId: params.localId,
                    echoToSender: true,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                },
            });

            const parsed = MessageAckResponseSchema.safeParse(raw);
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    };

    const queueSessionMessageUntilReconnect = (params: QueuedDisconnectedSessionMessage): void => {
        if (deps.getClosed()) return;
        queuedDisconnectedSessionMessages.set(params.localId, params);
        deps.requestReconnect?.(params.localId);
    };

    const enqueueMessageCommit = <T>(fn: () => Promise<T>): Promise<T> => {
        const queued = messageCommitQueueTail.then(fn, fn);
        messageCommitQueueTail = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    };

    const readRetryRecord = (token: CommitRetryToken): CommitRetryRecord | null => {
        const record = commitRetryByLocalId.get(token.localId);
        return record?.generation === token.generation ? record : null;
    };

    const clearRetryTimer = (record: CommitRetryRecord): void => {
        if (record.timer !== null) clearTimeout(record.timer);
        record.timer = null;
        record.timerEpoch += 1;
    };

    const beginRetryIntent = (params: CommitSessionMessageParams): CommitRetryToken => {
        const previous = commitRetryByLocalId.get(params.localId);
        if (previous) clearRetryTimer(previous);
        const generation = nextRetryGeneration++;
        commitRetryByLocalId.set(params.localId, {
            generation,
            params,
            attempts: 0,
            timer: null,
            timerEpoch: 0,
        });
        return { localId: params.localId, generation };
    };

    const completeRetryIntent = (token: CommitRetryToken): boolean => {
        const record = readRetryRecord(token);
        if (!record) return false;
        clearRetryTimer(record);
        commitRetryByLocalId.delete(token.localId);
        return true;
    };

    const isQueuedRetryIntent = (token: CommitRetryToken): boolean => {
        const queued = queuedDisconnectedSessionMessages.get(token.localId);
        return queued?.retryToken?.generation === token.generation;
    };

    let commitSessionMessageAttempt: (params: CommitSessionMessageParams, token: CommitRetryToken) => Promise<void>;

    const scheduleCommitRetry = (token: CommitRetryToken): void => {
        if (retryDisposed) return;
        const record = readRetryRecord(token);
        if (!record) return;
        if (!deps.hasPendingMaterializedLocalId(token.localId)) {
            completeRetryIntent(token);
            return;
        }
        if (record.attempts >= 3) {
            completeRetryIntent(token);
            return;
        }

        clearRetryTimer(record);
        record.attempts += 1;
        const delayMs = 1_000 * record.attempts;
        const timerEpoch = record.timerEpoch + 1;
        record.timerEpoch = timerEpoch;
        const timer = setTimeout(() => {
            const current = readRetryRecord(token);
            if (!current || current.timerEpoch !== timerEpoch) return;
            current.timer = null;
            if (!deps.hasPendingMaterializedLocalId(token.localId)) {
                completeRetryIntent(token);
                return;
            }
            void enqueueMessageCommit(async () => {
                const latest = readRetryRecord(token);
                if (!latest) return;
                try {
                    await commitSessionMessageAttempt(latest.params, token);
                } finally {
                    const afterAttempt = readRetryRecord(token);
                    if (afterAttempt?.timer === null && !isQueuedRetryIntent(token)) {
                        completeRetryIntent(token);
                    }
                }
            }).catch(() => {
                // Best-effort retry only; the matching current record retains its bounded budget.
            });
        }, delayMs);
        timer.unref?.();
        record.timer = timer;
    };

    const tryRequiredCommitFallback = async (
        params: CommitSessionMessageParams,
        token: CommitRetryToken,
    ): Promise<boolean> => {
        const ack = await deliverRequiredDirectSessionMessageViaHttp({
            token: deps.token,
            sessionId: deps.sessionId,
            localId: params.localId,
            message: params.message,
            sidechainId: params.sidechainId,
            ...(params.messageRole ? { messageRole: params.messageRole } : {}),
            ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
        });
        if (!ack) return false;
        completeRetryIntent(token);
        deps.markCommittedLocalIdAwaitingEcho(params.localId);
        deps.observeCommittedAck({
            seq: ack.seq,
            localId: ack.localId ?? params.localId,
            markAsUserMessage: params.markAsUserMessage,
            refreshAgentQueueEchoSuppression: params.refreshAgentQueueEchoSuppression,
        });
        return true;
    };

    const commitExternalSessionMessage = async (params: CommitSessionMessageParams, token: CommitRetryToken): Promise<void> => {
        const localId = params.localId;
        if (!deps.getSocket().connected) {
            if (params.requireCommit) {
                completeRetryIntent(token);
                throw new Error('Socket not connected');
            }
            queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                retryToken: token,
            });
            return;
        }

        if (!params.requireCommit) {
            deps.addPendingMaterializedLocalId(localId);
        }

        const ack = await emitSessionMessageWithAck({
            message: params.message,
            localId,
            sidechainId: params.sidechainId,
            messageRole: params.messageRole,
            sessionEventType: params.sessionEventType,
        });

        if (ack && ack.ok === true) {
            completeRetryIntent(token);
            deps.markCommittedLocalIdAwaitingEcho(localId);
            deps.observeCommittedAck({
                seq: ack.seq,
                localId,
                markAsUserMessage: params.markAsUserMessage,
                refreshAgentQueueEchoSuppression: params.refreshAgentQueueEchoSuppression,
            });
            return;
        }

        if (ack && ack.ok === false) {
            completeRetryIntent(token);
            if (!params.requireCommit) {
                deps.deleteMaterializedLocalId(localId);
            }
            throw new DefinitiveSessionMessageCommitError(ack.error);
        }

        if (!params.requireCommit) {
            scheduleCommitRetry(token);
            return;
        }

        completeRetryIntent(token);
        throw new Error('Message send not confirmed');
    };

    const commitPersistedSessionMessage = async (params: CommitSessionMessageParams, token: CommitRetryToken): Promise<void> => {
        const localId = params.localId;
        if (!deps.getSocket().connected) {
            if (params.requireCommit) {
                if (await tryRequiredCommitFallback(params, token)) {
                    return;
                }
                completeRetryIntent(token);
                throw new Error('Socket not connected');
            }
            queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                retryToken: token,
            });
            return;
        }

        deps.addPendingMaterializedLocalId(localId);
        const ack = await emitSessionMessageWithAck({
            message: params.message,
            localId,
            sidechainId: params.sidechainId,
            messageRole: params.messageRole,
            sessionEventType: params.sessionEventType,
        });

        if (ack && ack.ok === true) {
            completeRetryIntent(token);
            deps.markCommittedLocalIdAwaitingEcho(localId);
            deps.observeCommittedAck({
                seq: ack.seq,
                localId,
                markAsUserMessage: params.markAsUserMessage,
                refreshAgentQueueEchoSuppression: params.refreshAgentQueueEchoSuppression,
            });
            return;
        }

        if (ack && ack.ok === false) {
            completeRetryIntent(token);
            deps.deleteMaterializedLocalId(localId);
            if (params.requireCommit) {
                throw new DefinitiveSessionMessageCommitError(ack.error);
            }
            return;
        }

        if (params.requireCommit) {
            if (await tryRequiredCommitFallback(params, token)) {
                return;
            }
            throw new Error('Message commit not confirmed (ACK timed out)');
        }

        scheduleCommitRetry(token);
    };

    commitSessionMessageAttempt = async (params: CommitSessionMessageParams, token: CommitRetryToken): Promise<void> => {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return;
        }

        if (deps.transcriptStorage === 'direct') {
            await commitExternalSessionMessage(params, token);
            return;
        }

        await commitPersistedSessionMessage(params, token);
    };

    const commitSessionMessage = async (params: CommitSessionMessageParams): Promise<void> => {
        if (params.localId.length === 0) {
            if (params.requireCommit) throw new Error('localId is required');
            return;
        }
        if (retryDisposed) {
            if (params.requireCommit) throw new Error('Session message commit runtime is disposed');
            return;
        }
        const token = beginRetryIntent(params);
        try {
            await commitSessionMessageAttempt(params, token);
        } catch (error) {
            const current = readRetryRecord(token);
            if (current?.timer === null && !isQueuedRetryIntent(token)) completeRetryIntent(token);
            throw error;
        }
        const current = readRetryRecord(token);
        if (current?.timer === null && !isQueuedRetryIntent(token)) completeRetryIntent(token);
    };

    const flushQueuedSessionMessagesOnReconnect = async (): Promise<void> => {
        if (deps.getClosed()) return;
        if (!deps.getSocket().connected) return;
        if (queuedDisconnectedSessionMessages.size === 0) return;

        const queued = [...queuedDisconnectedSessionMessages.values()];
        queuedDisconnectedSessionMessages.clear();
        for (const params of queued) {
            const retryToken = params.retryToken;
            if (retryToken) {
                const current = readRetryRecord(retryToken);
                if (!current) continue;
                await enqueueMessageCommit(async () => {
                    try {
                        await commitSessionMessageAttempt(current.params, retryToken);
                    } finally {
                        const afterAttempt = readRetryRecord(retryToken);
                        if (afterAttempt?.timer === null && !isQueuedRetryIntent(retryToken)) {
                            completeRetryIntent(retryToken);
                        }
                    }
                });
                continue;
            }
            await enqueueMessageCommit(() => commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }));
        }
    };

    return {
        queuedDisconnectedSessionMessages,

        getMessageCommitQueueTail() {
            return messageCommitQueueTail;
        },

        enqueueMessageCommit,

        queueSessionMessageUntilReconnect,

        flushQueuedSessionMessagesOnReconnect,

        buildOutboundSessionMessagePayload(content) {
            if (deps.sessionEncryptionMode === 'plain') {
                return { t: 'plain', v: content };
            }
            return encodeBase64(encrypt(deps.encryptionKey, deps.encryptionVariant, content));
        },

        commitSessionMessage,

        commitSessionMessageBestEffort(params) {
            return enqueueMessageCommit(() =>
                commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                    markAsUserMessage: params.markAsUserMessage,
                    refreshAgentQueueEchoSuppression: params.refreshAgentQueueEchoSuppression,
                }),
            ).catch((error) => {
                logger.debug(params.logErrorMessage, { error });
            });
        },

        clearState() {
            queuedDisconnectedSessionMessages.clear();
            retryDisposed = true;
            for (const record of commitRetryByLocalId.values()) clearRetryTimer(record);
            commitRetryByLocalId.clear();
        },
    };
}

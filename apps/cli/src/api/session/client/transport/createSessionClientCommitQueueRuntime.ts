import { logger } from '@/ui/logger';
import { UnsupportedTranscriptLookupError } from '../lifecycle/createSessionClientRecoveryRuntime';

import { encodeBase64, encrypt } from '../../../encryption';
import { MessageAckResponseSchema, type ClientToServerEvents, type ServerToClientEvents } from '../../../types';
import type { Socket } from 'socket.io-client';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { deliverTranscriptMessageMutation } from './mutations/deliverTranscriptMessageMutation';
import { createTranscriptMessageAppendMutation } from './mutations/sessionClientDurableMutationTypes';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

type QueuedDisconnectedSessionMessage = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
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
        scheduleMaterializationRecovery: (localId: string) => void;
        recoverMaterializedLocalId: (localId: string, opts?: { maxWaitMs?: number }) => Promise<boolean>;
        observeCommittedAck: (params: { seq: number; localId?: string | null; markAsUserMessage?: boolean; refreshAgentQueueEchoSuppression?: boolean }) => void;
        requestReconnect?: (localId: string) => void;
    }>,
): SessionClientCommitQueueRuntime {
    const queuedDisconnectedSessionMessages = new Map<string, QueuedDisconnectedSessionMessage>();
    const pendingCommitRetryAttemptsByLocalId = new Map<string, number>();
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

    const scheduleCommitRetry = (params: QueuedDisconnectedSessionMessage): void => {
        const localId = params.localId;
        if (!localId) return;
        if (!deps.hasPendingMaterializedLocalId(localId)) return;

        const current = pendingCommitRetryAttemptsByLocalId.get(localId) ?? 0;
        const next = current + 1;
        if (next > 3) {
            return;
        }
        pendingCommitRetryAttemptsByLocalId.set(localId, next);

        const delayMs = 1_000 * next;
        const timer = setTimeout(() => {
            if (!deps.hasPendingMaterializedLocalId(localId)) {
                pendingCommitRetryAttemptsByLocalId.delete(localId);
                return;
            }
            void enqueueMessageCommit(() =>
                commitSessionMessage({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            ).catch(() => {
                // Best-effort retry only.
            });
        }, delayMs);
        timer.unref?.();
    };

    const tryRequiredCommitFallback = async (
        params: CommitSessionMessageParams,
    ): Promise<boolean> => {
        const result = await deliverTranscriptMessageMutation({
            token: deps.token,
            socket: null,
            mutation: createTranscriptMessageAppendMutation({
                sessionId: deps.sessionId,
                localId: params.localId,
                content: params.message,
                sidechainId: params.sidechainId,
                ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
            }),
        });
        if (!result.delivered || !result.ack) {
            return false;
        }
        pendingCommitRetryAttemptsByLocalId.delete(params.localId);
        deps.markCommittedLocalIdAwaitingEcho(params.localId);
        deps.observeCommittedAck({
            seq: result.ack.seq,
            localId: result.ack.localId ?? params.localId,
            markAsUserMessage: params.markAsUserMessage,
            refreshAgentQueueEchoSuppression: params.refreshAgentQueueEchoSuppression,
        });
        return true;
    };

    const commitExternalSessionMessage = async (params: CommitSessionMessageParams): Promise<void> => {
        const localId = params.localId;
        if (!deps.getSocket().connected) {
            if (params.requireCommit) {
                throw new Error('Socket not connected');
            }
            queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
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
            pendingCommitRetryAttemptsByLocalId.delete(localId);
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
            pendingCommitRetryAttemptsByLocalId.delete(localId);
            if (!params.requireCommit) {
                deps.deleteMaterializedLocalId(localId);
            }
            throw new DefinitiveSessionMessageCommitError(ack.error);
        }

        if (!params.requireCommit) {
            scheduleCommitRetry({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
            });
            return;
        }

        throw new Error('Message send not confirmed');
    };

    const commitPersistedSessionMessage = async (params: CommitSessionMessageParams): Promise<void> => {
        const localId = params.localId;
        if (!deps.getSocket().connected) {
            if (params.requireCommit) {
                if (await tryRequiredCommitFallback(params)) {
                    return;
                }
                throw new Error('Socket not connected');
            }
            queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
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
            pendingCommitRetryAttemptsByLocalId.delete(localId);
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
            pendingCommitRetryAttemptsByLocalId.delete(localId);
            deps.deleteMaterializedLocalId(localId);
            if (params.requireCommit) {
                throw new DefinitiveSessionMessageCommitError(ack.error);
            }
            return;
        }

        if (params.requireCommit) {
            if (await tryRequiredCommitFallback(params)) {
                return;
            }
            let recovered = false;
            try {
                recovered = await deps.recoverMaterializedLocalId(localId, { maxWaitMs: 12_000 });
            } catch (error) {
                if (error instanceof UnsupportedTranscriptLookupError) {
                    scheduleCommitRetry({
                        message: params.message,
                        localId,
                        sidechainId: params.sidechainId,
                        messageRole: params.messageRole,
                        sessionEventType: params.sessionEventType,
                    });
                    throw new Error(
                        'Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)',
                    );
                }
                throw error;
            }
            if (!recovered) {
                throw new Error('Message commit not confirmed (ACK timed out and transcript recovery failed)');
            }
            return;
        }

        deps.scheduleMaterializationRecovery(localId);
        scheduleCommitRetry({
            message: params.message,
            localId,
            sidechainId: params.sidechainId,
            messageRole: params.messageRole,
            sessionEventType: params.sessionEventType,
        });
    };

    const commitSessionMessage = async (params: CommitSessionMessageParams): Promise<void> => {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return;
        }

        if (deps.transcriptStorage === 'direct') {
            await commitExternalSessionMessage(params);
            return;
        }

        await commitPersistedSessionMessage(params);
    };

    const flushQueuedSessionMessagesOnReconnect = async (): Promise<void> => {
        if (deps.getClosed()) return;
        if (!deps.getSocket().connected) return;
        if (queuedDisconnectedSessionMessages.size === 0) return;

        const queued = [...queuedDisconnectedSessionMessages.values()];
        queuedDisconnectedSessionMessages.clear();
        for (const params of queued) {
            await enqueueMessageCommit(() =>
                commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            );
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
            pendingCommitRetryAttemptsByLocalId.clear();
        },
    };
}

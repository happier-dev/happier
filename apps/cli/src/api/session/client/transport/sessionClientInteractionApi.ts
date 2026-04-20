import { logger } from '@/ui/logger';
import { Socket } from 'socket.io-client';

import type {
    ClientToServerEvents,
    Metadata,
    ServerToClientEvents,
    Update,
    UserMessage,
} from '../../../types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    discardPendingQueueV2Messages,
    listPendingQueueV2LocalIdsFromServer,
    materializeNextPendingQueueV2Message,
} from '../../pendingQueueV2Transport';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { backoff } from '@/utils/time';
import { addDiscardedCommittedMessageLocalIds } from '../../../queue/discardedCommittedMessageLocalIds';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../../encryption';
import { buildDaemonInitialPromptLocalId } from '@/agent/runtime/daemonInitialPrompt';

export type SessionClientInteractionApi = Readonly<{
    onUserMessage: (callback: (data: UserMessage) => void) => void;
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
    ensureMetadataSnapshot: (opts?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<Metadata | null>;
    refreshSessionSnapshotFromServerBestEffort: (opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
    close: () => Promise<void>;
    installSessionSocketEventHandlers: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
    listPendingMessageQueueV2LocalIds: () => Promise<string[]>;
    peekPendingMessageQueueV2Count: () => Promise<number>;
    discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    popPendingMessage: () => Promise<boolean>;
}>;

export function createSessionClientInteractionApi(
    deps: Readonly<{
        sessionId: string;
        token: string;
        getClosed: () => boolean;
        setClosed: (value: boolean) => void;
        getSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getUserSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getSessionConnectionSupervisor: () => import('@happier-dev/connection-supervisor').ManagedConnectionSupervisor | null;
        getRpcHandlerManager: () => { handleRequest: (data: { method: string; params: unknown }) => Promise<unknown> };
        getMetadata: () => Metadata | null;
        setMetadata: (metadata: Metadata | null) => void;
        getMetadataVersion: () => number;
        setMetadataVersion: (version: number) => void;
        onMetadataUpdated: (handler: () => void) => void;
        offMetadataUpdated: (handler: () => void) => void;
        getAgentStateVersion: () => number;
        getPendingWakeSeq: () => number;
        getPendingMessages: () => UserMessage[];
        getPendingMessageCallback: () => ((message: UserMessage) => void) | null;
        setPendingMessageCallback: (callback: ((message: UserMessage) => void) | null) => void;
        getUserMessageCallbackAttachedAtMs: () => number | null;
        setUserMessageCallbackAttachedAtMs: (value: number | null) => void;
        clearUserSocketDisconnectTimer: () => void;
        kickUserSocketConnect: () => void;
        catchUpSessionMessages: (afterSeq: number) => Promise<void>;
        scheduleNextStartupMessageCatchUpRetry: () => void;
        getLastObservedMessageSeq: () => number;
        getStartedByDaemonProcess: () => boolean;
        getMetadataStartedBy: () => string | null;
        getMetadataStartedFromDaemon: () => boolean | null;
        getStartupMessageCatchUpStarted: () => boolean;
        setStartupMessageCatchUpStarted: (value: boolean) => void;
        setStartupMessageCatchUpRetryIndex: (value: number) => void;
        setStartupMessageCatchUpInitialAfterSeq: (value: number) => void;
        getDaemonInitialPrompt: () => string | null;
        setDaemonInitialPrompt: (value: string | null) => void;
        getDaemonInitialPromptSeeded: () => boolean;
        setDaemonInitialPromptSeeded: (value: boolean) => void;
        enqueueSessionUserMessage: (params: Readonly<{ text: string; localId?: string; meta?: Record<string, unknown> }>) => void;
        syncSessionSnapshotFromServer: (opts: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
        maybeScheduleUserSocketDisconnect: () => void;
        handleSessionScopedUpdate: (data: Update) => void;
        clearStartupMessageCatchUpRetryTimer: () => void;
        clearCommittedLocalIdCleanupTimers: () => void;
        clearAgentQueueEchoSuppressedLocalIdCleanupTimers: () => void;
        clearPendingMaterializedState: () => void;
        getPendingQueueMaterializedLocalIdsSize: () => number;
        scheduleMaterializationRecovery: (localId: string) => void;
        getMetadataLock: () => { inLock: <T>(fn: () => Promise<T>) => Promise<T> };
        getSessionEncryptionMode: () => 'e2ee' | 'plain';
        getEncryptionKey: () => Uint8Array;
        getEncryptionVariant: () => 'legacy' | 'dataKey';
    }>,
): SessionClientInteractionApi {
    return {
        onUserMessage(callback) {
            logger.debug('[API] onUserMessage callback attached', {
                sessionId: deps.sessionId,
                startedByDaemonProcess: deps.getStartedByDaemonProcess(),
                metadataStartedBy: deps.getMetadataStartedBy(),
                metadataStartedFromDaemon: deps.getMetadataStartedFromDaemon(),
            });
            deps.setPendingMessageCallback(callback);
            if (deps.getUserMessageCallbackAttachedAtMs() === null) {
                deps.setUserMessageCallbackAttachedAtMs(Date.now());
            }
            deps.clearUserSocketDisconnectTimer();
            deps.kickUserSocketConnect();
            const startupCatchUpInitialAfterSeq = deps.getLastObservedMessageSeq();
            const pendingMessages = deps.getPendingMessages();
            while (pendingMessages.length > 0) {
                callback(pendingMessages.shift()!);
            }
            if (!deps.getStartupMessageCatchUpStarted()) {
                deps.setStartupMessageCatchUpStarted(true);
                deps.setStartupMessageCatchUpRetryIndex(0);
                deps.setStartupMessageCatchUpInitialAfterSeq(startupCatchUpInitialAfterSeq);
                void deps.catchUpSessionMessages(startupCatchUpInitialAfterSeq)
                    .catch((error) => {
                        if (isAuthenticationError(error)) {
                            logger.debug('[API] Initial transcript catch-up failed with terminal auth', { error });
                            return false;
                        }
                        logger.debug('[API] Initial transcript catch-up failed (non-fatal)', { error });
                        return true;
                    })
                    .then((shouldContinue) => {
                        if (shouldContinue !== false) {
                            deps.scheduleNextStartupMessageCatchUpRetry();
                        }
                    });
            }
            if (!deps.getDaemonInitialPromptSeeded() && typeof deps.getDaemonInitialPrompt() === 'string') {
                deps.setDaemonInitialPromptSeeded(true);
                const initialPrompt = deps.getDaemonInitialPrompt();
                const initialPromptLocalId = buildDaemonInitialPromptLocalId(deps.sessionId);
                deps.setDaemonInitialPrompt(null);
                deps.enqueueSessionUserMessage({
                    text: initialPrompt!,
                    ...(initialPromptLocalId ? { localId: initialPromptLocalId } : {}),
                    meta: {
                        source: 'daemon-initial-prompt',
                        sentFrom: 'cli',
                    },
                });
            }
        },

        waitForMetadataUpdate(abortSignal) {
            if (abortSignal?.aborted) {
                return Promise.resolve(false);
            }

            const startMetadataVersion = deps.getMetadataVersion();
            const startAgentStateVersion = deps.getAgentStateVersion();
            const startPendingWakeSeq = deps.getPendingWakeSeq();
            if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
                void deps.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            }
            return new Promise((resolve) => {
                let cleanedUp = false;
                const userSocket = deps.getUserSocket();
                const shouldWatchConnect = !userSocket.connected;
                const onUpdate = () => {
                    cleanup();
                    resolve(true);
                };
                const onConnect = () => {
                    void (async () => {
                        await deps.syncSessionSnapshotFromServer({ reason: 'connect' });
                        cleanup();
                        resolve(true);
                    })();
                };
                const onAbort = () => {
                    cleanup();
                    resolve(false);
                };
                const onDisconnect = () => {
                    cleanup();
                    resolve(false);
                };
                const cleanup = () => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    deps.offMetadataUpdated(onUpdate);
                    deps.getUserSocket().off('connect', onConnect);
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket().off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket().on('disconnect', onDisconnect);
                if (shouldWatchConnect) {
                    deps.getUserSocket().on('connect', onConnect);
                }
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                deps.kickUserSocketConnect();

                if (abortSignal?.aborted) {
                    onAbort();
                    return;
                }
                if (
                    deps.getMetadataVersion() !== startMetadataVersion
                    || deps.getAgentStateVersion() !== startAgentStateVersion
                    || deps.getPendingWakeSeq() !== startPendingWakeSeq
                ) {
                    onUpdate();
                    return;
                }
                if (shouldWatchConnect && deps.getUserSocket().connected) {
                    onConnect();
                }
            });
        },

        async ensureMetadataSnapshot(opts) {
            const abortSignal = opts?.abortSignal;
            if (abortSignal?.aborted) return null;
            const currentMetadata = deps.getMetadata();
            if (deps.getMetadataVersion() >= 0 && currentMetadata) {
                return currentMetadata;
            }

            const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 15_000;
            if (deps.getMetadataVersion() < 0) {
                void deps.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            }

            return await new Promise((resolve) => {
                let cleanedUp = false;
                const timer = setTimeout(() => {
                    cleanup();
                    resolve(deps.getMetadataVersion() >= 0 ? deps.getMetadata() : null);
                }, timeoutMs);
                timer.unref?.();
                const onAbort = () => {
                    cleanup();
                    resolve(null);
                };
                const onDisconnect = () => {
                    cleanup();
                    resolve(null);
                };
                const onUpdate = () => {
                    const metadata = deps.getMetadata();
                    if (deps.getMetadataVersion() >= 0 && metadata) {
                        cleanup();
                        resolve(metadata);
                    }
                };
                const cleanup = () => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    clearTimeout(timer);
                    deps.offMetadataUpdated(onUpdate);
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket().off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket().on('disconnect', onDisconnect);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                onUpdate();
            });
        },

        async refreshSessionSnapshotFromServerBestEffort(opts) {
            const reason = opts?.reason ?? 'waitForMetadataUpdate';
            await deps.syncSessionSnapshotFromServer({ reason });
        },

        async close() {
            logger.debug('[API] socket.close() called');
            deps.setClosed(true);
            deps.clearStartupMessageCatchUpRetryTimer();
            deps.clearUserSocketDisconnectTimer();
            deps.clearPendingMaterializedState();
            deps.clearCommittedLocalIdCleanupTimers();
            deps.clearAgentQueueEchoSuppressedLocalIdCleanupTimers();
            try {
                deps.getUserSocket().close();
            } catch {
                // ignore
            }
            await deps.getSessionConnectionSupervisor()?.stop();
        },

        installSessionSocketEventHandlers(socket) {
            socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string; params: unknown }, callback: (response: unknown) => void) => {
                callback(await deps.getRpcHandlerManager().handleRequest(data));
            });
            socket.on('connect_error', (error) => {
                logger.debug('[API] Socket connection error:', error);
            });
            socket.on('update', (data: Update) => deps.handleSessionScopedUpdate(data));
            socket.on('session', () => {});
            socket.on('error', (error) => {
                logger.debug('[API] Socket error:', error);
            });
        },

        async listPendingMessageQueueV2LocalIds() {
            const request = () => listPendingQueueV2LocalIdsFromServer({
                token: deps.token,
                sessionId: deps.sessionId,
            });
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            try {
                return await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    throw error;
                }
                return [];
            }
        },

        async peekPendingMessageQueueV2Count() {
            const localIds = await this.listPendingMessageQueueV2LocalIds();
            return localIds.length + deps.getPendingQueueMaterializedLocalIdsSize();
        },

        async discardPendingMessageQueueV2All(opts) {
            const localIds = await this.listPendingMessageQueueV2LocalIds();
            if (localIds.length === 0) return 0;
            const request = () => discardPendingQueueV2Messages({
                token: deps.token,
                sessionId: deps.sessionId,
                localIds,
                reason: opts.reason,
            });
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            try {
                return await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    throw error;
                }
                return 0;
            }
        },

        async discardCommittedMessageLocalIds(opts) {
            const socket = deps.getSocket();
            if (!socket.connected) {
                return 0;
            }
            if (!deps.getMetadata()) {
                return 0;
            }

            const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
            if (localIds.length === 0) {
                return 0;
            }

            let addedCount = 0;
            await deps.getMetadataLock().inLock(async () => {
                await backoff(async () => {
                    const current = deps.getMetadata() as Record<string, unknown>;
                    const existingRaw = (current as { discardedCommittedMessageLocalIds?: unknown }).discardedCommittedMessageLocalIds;
                    const existing = Array.isArray(existingRaw) ? existingRaw.filter((v) => typeof v === 'string') : [];
                    const existingSet = new Set(existing);
                    const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                    if (uniqueNew.length === 0) {
                        addedCount = 0;
                        return;
                    }

                    const nextMetadata = addDiscardedCommittedMessageLocalIds(current, uniqueNew);
                    const metadataPayload =
                        deps.getSessionEncryptionMode() === 'plain'
                            ? JSON.stringify(nextMetadata)
                            : encodeBase64(encrypt(deps.getEncryptionKey(), deps.getEncryptionVariant(), nextMetadata));
                    const answer = await socket.emitWithAck('update-metadata', {
                        sid: deps.sessionId,
                        expectedVersion: deps.getMetadataVersion(),
                        metadata: metadataPayload,
                    });
                    if (answer.result === 'success') {
                        deps.setMetadata(
                            deps.getSessionEncryptionMode() === 'plain'
                                ? JSON.parse(String(answer.metadata ?? 'null'))
                                : decrypt(deps.getEncryptionKey(), deps.getEncryptionVariant(), decodeBase64(answer.metadata)),
                        );
                        deps.setMetadataVersion(answer.version);
                        addedCount = uniqueNew.length;
                        return;
                    }
                    if (answer.result === 'version-mismatch') {
                        if (answer.version > deps.getMetadataVersion()) {
                            deps.setMetadataVersion(answer.version);
                            deps.setMetadata(
                                deps.getSessionEncryptionMode() === 'plain'
                                    ? JSON.parse(String(answer.metadata ?? 'null'))
                                    : decrypt(deps.getEncryptionKey(), deps.getEncryptionVariant(), decodeBase64(answer.metadata)),
                            );
                        }
                        throw new Error('Metadata version mismatch');
                    }
                    addedCount = 0;
                });
            });
            return addedCount;
        },

        async popPendingMessage() {
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return false;
            }
            let materializeResult;
            try {
                materializeResult = await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request: async () => materializeNextPendingQueueV2Message({
                        token: deps.token,
                        sessionId: deps.sessionId,
                        socket: deps.getSocket(),
                    }),
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    throw error;
                }
                return false;
            }
            if (!materializeResult.didMaterialize) {
                return false;
            }
            if (materializeResult.didWrite && materializeResult.localId) {
                deps.scheduleMaterializationRecovery(materializeResult.localId);
            }
            return true;
        },
    };
}

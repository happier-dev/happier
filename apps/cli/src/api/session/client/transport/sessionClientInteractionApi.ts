import { logger } from '@/ui/logger';
import { Socket } from 'socket.io-client';
import { configuration } from '@/configuration';

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
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from '../../pendingQueueV2Transport';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { backoff } from '@/utils/time';
import { addDiscardedCommittedMessageLocalIds } from '../../../queue/discardedCommittedMessageLocalIds';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../../encryption';
import { buildDaemonInitialPromptLocalId } from '@/agent/runtime/daemonInitialPrompt';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import type { KnownPendingQueueState, PendingQueueState } from '../../pendingQueueState';
import type { MaterializeNextPendingResult } from '../../sessionClientPort';
import { serializeAxiosErrorForLog } from '../../../client/serializeAxiosErrorForLog';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';

function arePendingQueueStatesEqual(left: PendingQueueState, right: PendingQueueState): boolean {
    if (left.known !== right.known) return false;
    if (!left.known || !right.known) return true;
    return left.pendingCount === right.pendingCount && left.pendingVersion === right.pendingVersion;
}

function createMaterializedPendingQueueUpdate(params: {
    sessionId: string;
    message: PendingQueueMaterializedMessage | null | undefined;
}): Update | null {
    const { message, sessionId } = params;
    if (!message?.id || !message.content) return null;
    const createdAt = message.createdAt ?? Date.now();
    const updatedAt = message.updatedAt ?? createdAt;
    return {
        id: `pending-materialized-${message.id}`,
        seq: 0,
        createdAt,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                content: message.content,
                localId: message.localId,
                createdAt,
                updatedAt,
                ...(typeof message.messageRole === 'string' ? { messageRole: message.messageRole } : {}),
            },
        },
    } as Update;
}

export type SessionClientInteractionApi = Readonly<{
    onUserMessage: (callback: (data: UserMessage) => void) => void;
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
    ensureMetadataSnapshot: (opts?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<Metadata | null>;
    refreshSessionSnapshotFromServerBestEffort: (opts?: { reason?: SessionSnapshotRefreshReason }) => Promise<void>;
    close: () => Promise<void>;
    installSessionSocketEventHandlers: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
    listPendingMessageQueueV2LocalIds: () => Promise<string[]>;
    peekPendingMessageQueueV2Count: () => Promise<number>;
    reconcilePendingQueueState: (opts?: { force?: boolean }) => Promise<boolean>;
    discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    materializeNextPendingMessageSafely: (opts?: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    }) => Promise<MaterializeNextPendingResult>;
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
        catchUpSessionMessages: (afterSeq: number, opts?: { afterSeqIsExplicit?: boolean }) => Promise<void>;
        scheduleNextStartupMessageCatchUpRetry: () => void;
        getLastObservedMessageSeq: () => number;
        getStartupMessageCatchUpExplicitAfterSeq: () => number | null;
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
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<void>;
        reconcileTurnStatusBeforePendingMaterialization: () => Promise<boolean>;
        maybeScheduleUserSocketDisconnect: () => void;
        handleSessionScopedUpdate: (data: Update) => void;
        clearStartupMessageCatchUpRetryTimer: () => void;
        stopStaleSafety: () => void;
        clearCommittedLocalIdCleanupTimers: () => void;
        clearAgentQueueEchoSuppressedLocalIdCleanupTimers: () => void;
        clearPendingMaterializedState: () => void;
        getPendingQueueMaterializedLocalIdsSize: () => number;
        shouldAttemptPendingMaterialization: () => boolean;
        getPendingQueueState: () => PendingQueueState;
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        observePendingMaterializeResult: (params: Readonly<{ didMaterialize: boolean; pendingQueueState?: KnownPendingQueueState | null }>) => boolean;
        onPendingQueueStateChanged: () => void;
        scheduleMaterializationRecovery: (localId: string) => void;
        getMetadataLock: () => { inLock: <T>(fn: () => Promise<T>) => Promise<T> };
        getSessionEncryptionMode: () => 'e2ee' | 'plain';
        getEncryptionKey: () => Uint8Array;
        getEncryptionVariant: () => 'legacy' | 'dataKey';
    }>,
): SessionClientInteractionApi {
    let pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    let lastPendingQueueStateReconcileAt = 0;

    const runMaterializeNextPendingMessageInner = async (): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> => {
        const supervisor = deps.getSessionConnectionSupervisor();
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        try {
            materializeResult = await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request: async () => {
                    const pendingQueueState = deps.getPendingQueueState();
                    return await materializeNextPendingQueueV2Message({
                        token: deps.token,
                        sessionId: deps.sessionId,
                        socket: deps.getSocket(),
                        knownPendingVersion: pendingQueueState.known ? pendingQueueState.pendingVersion : undefined,
                    });
                },
            });
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            logger.debug('[pendingQueue] materialize request failed', {
                sessionId: deps.sessionId,
                errorName: error instanceof Error ? error.name : typeof error,
            });
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const pendingStateChanged = deps.observePendingMaterializeResult({
            didMaterialize: materializeResult.didMaterialize,
            pendingQueueState: materializeResult.pendingQueueState,
        });
        if (pendingStateChanged) {
            deps.onPendingQueueStateChanged();
        }
        if (!materializeResult.didMaterialize) {
            const state = deps.getPendingQueueState();
            logger.debug('[pendingQueue] materialize result', {
                sessionId: deps.sessionId,
                didMaterialize: false,
                pendingCount: state.known ? state.pendingCount : undefined,
                pendingVersion: state.known ? state.pendingVersion : undefined,
            });
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const materializedUpdate = createMaterializedPendingQueueUpdate({
            sessionId: deps.sessionId,
            message: materializeResult.message,
        });
        if (materializedUpdate) {
            deps.handleSessionScopedUpdate(materializedUpdate);
        }
        const state = deps.getPendingQueueState();
        logger.debug('[pendingQueue] materialize result', {
            sessionId: deps.sessionId,
            didMaterialize: true,
            localId: materializeResult.localId ?? materializeResult.message?.localId ?? null,
            didWrite: materializeResult.didWrite,
            messageSeq: materializeResult.message?.seq ?? null,
            messageRole: materializeResult.message?.messageRole ?? null,
            deliveredMaterializedMessage: materializedUpdate !== null,
            pendingCount: state.known ? state.pendingCount : undefined,
            pendingVersion: state.known ? state.pendingVersion : undefined,
        });
        if (materializeResult.localId && !materializedUpdate) {
            deps.scheduleMaterializationRecovery(materializeResult.localId);
        }

        const message = materializeResult.message;
        if (
            message
            && typeof message.localId === 'string'
            && message.localId.length > 0
            && typeof message.seq === 'number'
            && Number.isSafeInteger(message.seq)
            && message.seq >= 0
        ) {
            return {
                didMaterialize: true,
                result: {
                    type: 'materialized',
                    localId: message.localId,
                    seq: message.seq,
                    content: message.content ?? null,
                    ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
                    ...(typeof message.updatedAt === 'number' ? { updatedAt: message.updatedAt } : {}),
                },
            };
        }

        return { didMaterialize: true, result: { type: 'no_pending' } };
    };

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
            const explicitStartupAfterSeq = deps.getStartupMessageCatchUpExplicitAfterSeq();
            const startupCatchUpInitialAfterSeq =
                explicitStartupAfterSeq !== null
                    ? explicitStartupAfterSeq
                    : deps.getLastObservedMessageSeq();
            const startupCatchUpInitialAfterSeqIsExplicit = explicitStartupAfterSeq !== null;
            const pendingMessages = deps.getPendingMessages();
            while (pendingMessages.length > 0) {
                callback(pendingMessages.shift()!);
            }
            if (!deps.getStartupMessageCatchUpStarted()) {
                deps.setStartupMessageCatchUpStarted(true);
                deps.setStartupMessageCatchUpRetryIndex(0);
                deps.setStartupMessageCatchUpInitialAfterSeq(startupCatchUpInitialAfterSeq);
                void deps.catchUpSessionMessages(startupCatchUpInitialAfterSeq, {
                    afterSeqIsExplicit: startupCatchUpInitialAfterSeqIsExplicit,
                })
                    .catch((error) => {
                        if (isAuthenticationError(error)) {
                            logger.debug('[API] Initial transcript catch-up failed with terminal auth', {
                                error: serializeAxiosErrorForLog(error),
                            });
                            return false;
                        }
                        logger.debug('[API] Initial transcript catch-up failed (non-fatal)', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return true;
                    })
                    .then((shouldContinue) => {
                        if (shouldContinue === true) {
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
            return new Promise((resolve) => {
                let cleanedUp = false;
                const onUpdate = () => {
                    cleanup();
                    resolve(true);
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
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket().off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket().on('disconnect', onDisconnect);
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
            if (
                reason === 'waitForMetadataUpdate'
                && deps.getMetadataVersion() >= 0
            ) {
                return;
            }
            await deps.syncSessionSnapshotFromServer({ reason });
        },

        async close() {
            logger.debug('[API] socket.close() called');
            deps.setClosed(true);
            deps.clearStartupMessageCatchUpRetryTimer();
            deps.stopStaleSafety();
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
                logger.debug('[API] Socket connection error:', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            socket.on('update', (data: Update) => deps.handleSessionScopedUpdate(data));
            socket.on('session', () => {});
            socket.on('error', (error) => {
                logger.debug('[API] Socket error:', {
                    error: serializeAxiosErrorForLog(error),
                });
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
                throw error;
            }
        },

        async peekPendingMessageQueueV2Count() {
            const materializedCount = deps.getPendingQueueMaterializedLocalIdsSize();
            if (!deps.shouldAttemptPendingMaterialization()) {
                if (!deps.getPendingQueueState().known) {
                    await this.reconcilePendingQueueState({ force: true });
                }
                const pendingQueueState = deps.getPendingQueueState();
                if (pendingQueueState.known) {
                    return pendingQueueState.pendingCount + materializedCount;
                }
                if (!deps.shouldAttemptPendingMaterialization()) {
                    return materializedCount;
                }
            }
            const localIds = await this.listPendingMessageQueueV2LocalIds();
            return localIds.length + materializedCount;
        },

        async reconcilePendingQueueState(opts) {
            if (deps.getClosed()) return false;
            if (!opts?.force && deps.shouldAttemptPendingMaterialization()) {
                return false;
            }

            const now = Date.now();
            if (
                !opts?.force
                && lastPendingQueueStateReconcileAt > 0
                && now - lastPendingQueueStateReconcileAt < configuration.pendingQueueStateReconcileThrottleMs
            ) {
                return false;
            }

            if (pendingQueueStateReconcileInFlight) {
                return await pendingQueueStateReconcileInFlight;
            }

            const run = async (): Promise<boolean> => {
                lastPendingQueueStateReconcileAt = Date.now();
                const before = deps.getPendingQueueState();
                await deps.syncSessionSnapshotFromServer({
                    reason: opts?.force ? 'startup-drain' : 'waitForMetadataUpdate',
                });
                return !arePendingQueueStatesEqual(before, deps.getPendingQueueState());
            };

            const reconcile = run().finally(() => {
                if (pendingQueueStateReconcileInFlight === reconcile) {
                    pendingQueueStateReconcileInFlight = null;
                }
            });
            pendingQueueStateReconcileInFlight = reconcile;
            return await reconcile;
        },

        async discardPendingMessageQueueV2All(opts) {
            const pendingQueueState = deps.getPendingQueueState();
            if (pendingQueueState.known && pendingQueueState.pendingCount <= 0) return 0;
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
                throw error;
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
                    const answer = await emitSocketWithAck<any>({
                        socket: socket as any,
                        event: 'update-metadata',
                        payload: {
                            sid: deps.sessionId,
                            expectedVersion: deps.getMetadataVersion(),
                            metadata: metadataPayload,
                        },
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

        async materializeNextPendingMessageSafely(opts: {
            reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
        } = {}) {
            const supervisorState = deps.getSessionConnectionSupervisor()?.getState();
            if (supervisorState?.phase === 'auth_failed') {
                return { type: 'deferred', reason: 'supervisor_auth_failed' };
            }
            if (supervisorState && supervisorState.phase !== 'online') {
                return { type: 'deferred', reason: 'supervisor_offline' };
            }

            const policy = opts.reconcileWhenEmpty ?? 'force';
            const pendingQueueState = deps.getPendingQueueState();
            if (!pendingQueueState.known) {
                await this.reconcilePendingQueueState({ force: true });
            } else if (pendingQueueState.pendingCount <= 0) {
                if (policy === 'force') {
                    await this.reconcilePendingQueueState({ force: true });
                } else if (policy === 'throttled') {
                    await this.reconcilePendingQueueState({ force: false });
                }
            }
            if (!deps.shouldAttemptPendingMaterialization()) {
                return { type: 'no_pending' };
            }
            const refreshedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
            if (!refreshedTurnStatus) {
                return { type: 'no_pending' };
            }
            if (!deps.shouldAttemptPendingMaterialization()) {
                return { type: 'no_pending' };
            }

            const inner = await runMaterializeNextPendingMessageInner();
            return inner.result;
        },

        async popPendingMessage() {
            if (!deps.shouldAttemptPendingMaterialization()) {
                await this.reconcilePendingQueueState({ force: !deps.getPendingQueueState().known });
            }
            const refreshedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
            if (!refreshedTurnStatus) {
                return false;
            }
            if (!deps.shouldAttemptPendingMaterialization()) {
                return false;
            }
            const inner = await runMaterializeNextPendingMessageInner();
            return inner.didMaterialize;
        },
    };
}

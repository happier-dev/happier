import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import type { Update } from '../../../types';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { waitForTranscriptEncryptedMessageByLocalId } from '../../transcriptMessageLookup';
import { catchUpSessionMessagesAfterSeq } from '../../sessionMessageCatchUp';
import { createKeyedSingleFlightScheduler } from '../../../connection/scheduling/createKeyedSingleFlightScheduler';
import { isV2ChangesSyncEnabled, runSessionChangesSyncOnConnect } from '../../sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../../../changes';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import { createSessionSocketStaleSafetyScheduler } from '../../sessionSocketStaleSafety';

export class UnsupportedTranscriptLookupError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super('Transcript lookup route is unavailable on the server');
        this.name = 'UnsupportedTranscriptLookupError';
        this.cause = cause;
    }
}

export type SessionClientRecoveryRuntime = Readonly<{
    catchUpSessionMessages: (afterSeq: number, opts?: { afterSeqIsExplicit?: boolean }) => Promise<void>;
    scheduleNextStartupMessageCatchUpRetry: () => void;
    clearStartupMessageCatchUpRetryTimer: () => void;
    syncChangesOnConnect: (opts: { reason: 'connect' | 'reconnect' | 'stale-safety' }) => Promise<void>;
    recoverMaterializedLocalId: (localId: string, opts?: { maxWaitMs?: number }) => Promise<boolean>;
    scheduleMaterializationRecovery: (localId: string) => void;
    forgetMaterializationRecovery: (localId: string) => void;
    stopStaleSafety: () => void;
}>;

export function createSessionClientRecoveryRuntime(
    params: Readonly<{
        startupMessageCatchUpRetryDelaysMs: readonly number[];
        token: string;
        sessionId: string;
        getClosed: () => boolean;
        getSessionConnectionSupervisor: () => ManagedConnectionSupervisor | null;
        getCurrentConnectionState: () => ManagedConnectionState;
        getStartedByDaemonProcess: () => boolean;
        getMetadataStartedBy: () => string | null;
        getMetadataStartedFromDaemon: () => boolean | null;
        getStartupMessageCatchUpRetryIndex: () => number;
        setStartupMessageCatchUpRetryIndex: (value: number) => void;
        getStartupMessageCatchUpInitialAfterSeq: () => number;
        getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => boolean;
        getLastObservedMessageSeq: () => number;
        getHasMaterializedLocalId: (localId: string) => boolean;
        deleteMaterializedLocalId: (localId: string) => void;
        handleUpdate: (update: Update, opts: { source: 'session-scoped' | 'user-scoped'; catchUpAfterSeq?: number; catchUpAfterSeqIsExplicit?: boolean }) => void;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<void>;
        applyPendingQueueState: (state: KnownPendingQueueState) => void;
    }>,
): SessionClientRecoveryRuntime {
    let accountIdPromise: Promise<string> | null = null;
    let changesSyncInFlight: Promise<void> | null = null;
    let startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const materializationRecoveryScheduler = createKeyedSingleFlightScheduler({
        delayMs: configuration.transcriptRecoveryDelayMs,
        maxConcurrent: configuration.transcriptRecoveryMaxConcurrent,
    });
    const staleSafetyScheduler = createSessionSocketStaleSafetyScheduler({
        intervalMs: configuration.sessionSocketStaleSafetyIntervalMs,
        isOnline: () => {
            const phase = params.getCurrentConnectionState()?.phase;
            return phase === 'online';
        },
        runSafetyTick: async () => {
            await syncChangesOnConnect({ reason: 'stale-safety' });
        },
    });
    const transcriptRecoveryErrorStateByLocalId = new Map<string, { lastLoggedAt: number; suppressed: number }>();

    const debugTranscriptRecoveryFetchError = (localId: string, error: unknown): void => {
        const now = Date.now();
        const throttleMs = configuration.transcriptRecoveryErrorLogThrottleMs;
        const state = transcriptRecoveryErrorStateByLocalId.get(localId) ?? { lastLoggedAt: 0, suppressed: 0 };

        if (state.lastLoggedAt === 0 || now - state.lastLoggedAt >= throttleMs) {
            const suppressed = state.suppressed;
            state.lastLoggedAt = now;
            state.suppressed = 0;
            transcriptRecoveryErrorStateByLocalId.set(localId, state);
            logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', {
                localId,
                suppressedSinceLastLog: suppressed,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        state.suppressed += 1;
        transcriptRecoveryErrorStateByLocalId.set(localId, state);
    };

    const catchUpSessionMessages = async (afterSeq: number, opts: { afterSeqIsExplicit?: boolean } = {}): Promise<void> => {
        const request = () => catchUpSessionMessagesAfterSeq({
            token: params.token,
            sessionId: params.sessionId,
            afterSeq,
            onUpdate: (update) => params.handleUpdate(update, {
                source: 'session-scoped',
                catchUpAfterSeq: afterSeq,
                catchUpAfterSeqIsExplicit: opts.afterSeqIsExplicit,
            }),
        });
        const supervisor = params.getSessionConnectionSupervisor();
        if (!supervisor) {
            await request();
            return;
        }
        await runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    };

    const shouldRunStartupTranscriptCatchUp = (): boolean =>
        params.getStartedByDaemonProcess()
        || params.getMetadataStartedBy() === 'daemon'
        || params.getMetadataStartedFromDaemon() === true;

    const clearStartupMessageCatchUpRetryTimer = (): void => {
        if (!startupMessageCatchUpRetryTimer) return;
        clearTimeout(startupMessageCatchUpRetryTimer);
        startupMessageCatchUpRetryTimer = null;
    };

    const scheduleNextStartupMessageCatchUpRetry = (): void => {
        if (params.getClosed()) return;
        if (startupMessageCatchUpRetryTimer) return;
        if (!shouldRunStartupTranscriptCatchUp()) return;
        if (params.getCurrentConnectionState()?.phase === 'auth_failed') return;

        const retryIndex = params.getStartupMessageCatchUpRetryIndex();
        const delayMs = params.startupMessageCatchUpRetryDelaysMs[retryIndex];
        if (typeof delayMs !== 'number') return;

        logger.debug('[API] Scheduling startup transcript catch-up retry', {
            delayMs,
            retryIndex,
            startupMessageCatchUpInitialAfterSeq: params.getStartupMessageCatchUpInitialAfterSeq(),
            startupMessageCatchUpInitialAfterSeqIsExplicit: params.getStartupMessageCatchUpInitialAfterSeqIsExplicit(),
            lastObservedMessageSeq: params.getLastObservedMessageSeq(),
        });
        startupMessageCatchUpRetryTimer = setTimeout(() => {
            startupMessageCatchUpRetryTimer = null;
            if (params.getClosed()) return;

            params.setStartupMessageCatchUpRetryIndex(retryIndex + 1);
            logger.debug('[API] Running startup transcript catch-up retry', {
                retryIndex: retryIndex + 1,
                afterSeq: params.getStartupMessageCatchUpInitialAfterSeq(),
                afterSeqIsExplicit: params.getStartupMessageCatchUpInitialAfterSeqIsExplicit(),
            });
            void catchUpSessionMessages(params.getStartupMessageCatchUpInitialAfterSeq(), {
                afterSeqIsExplicit: params.getStartupMessageCatchUpInitialAfterSeqIsExplicit(),
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Startup transcript catch-up retry failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Startup transcript catch-up retry failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue === true) {
                        scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }, delayMs);
        startupMessageCatchUpRetryTimer.unref?.();
    };

    const getAccountId = async (): Promise<string | null> => {
        if (accountIdPromise) {
            try {
                return await accountIdPromise;
            } catch (error) {
                accountIdPromise = null;
                if (isAuthenticationError(error)) {
                    if (params.getSessionConnectionSupervisor()) {
                        return null;
                    }
                    throw error;
                }
                return null;
            }
        }

        const request = () => fetchChangesAccountId({ token: params.token });
        const supervisor = params.getSessionConnectionSupervisor();
        const pending = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        accountIdPromise = pending;
        try {
            return await pending;
        } catch (error) {
            accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    };

    const syncChangesOnConnect = async (opts: { reason: 'connect' | 'reconnect' | 'stale-safety' }): Promise<void> => {
        if (!isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES)) {
            return;
        }

        if (params.getClosed()) return;
        if (changesSyncInFlight) {
            await changesSyncInFlight.catch(() => {});
        }

        const pending = runSessionChangesSyncOnConnect({
            reason: opts.reason,
            token: params.token,
            sessionId: params.sessionId,
            lastObservedMessageSeq: params.getLastObservedMessageSeq(),
            getAccountId,
            catchUpSessionMessages: (afterSeq) => catchUpSessionMessages(afterSeq),
            syncSessionSnapshotFromServer: (syncOpts) => params.syncSessionSnapshotFromServer(syncOpts),
            applyPendingQueueState: (state) => params.applyPendingQueueState(state),
            connectionSupervisor: params.getSessionConnectionSupervisor(),
            onDebug: (message, data) => logger.debug(message, data),
        });

        changesSyncInFlight = pending;
        try {
            await pending;
        } finally {
            if (changesSyncInFlight === pending) {
                changesSyncInFlight = null;
            }
        }
        if (opts.reason === 'connect' || opts.reason === 'reconnect') {
            staleSafetyScheduler.start();
        }
    };

    const recoverMaterializedLocalId = async (localId: string, opts?: { maxWaitMs?: number }): Promise<boolean> => {
        let unsupportedLookupError: unknown = null;
        const found = await waitForTranscriptEncryptedMessageByLocalId({
            token: params.token,
            sessionId: params.sessionId,
            localId,
            supervisor: params.getSessionConnectionSupervisor() ?? undefined,
            maxWaitMs: opts?.maxWaitMs,
            onError: (error) => {
                debugTranscriptRecoveryFetchError(localId, error);
            },
            onUnsupported: (error) => {
                unsupportedLookupError = error;
            },
        });
        if (unsupportedLookupError !== null) {
            throw new UnsupportedTranscriptLookupError(unsupportedLookupError);
        }
        if (!found) return false;

        params.deleteMaterializedLocalId(localId);
        params.handleUpdate({
            id: `recovered-${localId}`,
            seq: 0,
            createdAt: found.createdAt,
            body: {
                t: 'new-message',
                sid: params.sessionId,
                message: {
                    id: found.id,
                    seq: found.seq,
                    content: found.content,
                    localId: found.localId,
                    sidechainId: found.sidechainId,
                    createdAt: found.createdAt,
                    updatedAt: found.updatedAt,
                },
            },
        } as Update, { source: 'session-scoped' });
        return true;
    };

    const scheduleMaterializationRecovery = (localId: string): void => {
        materializationRecoveryScheduler.schedule(localId, async () => {
            if (!params.getHasMaterializedLocalId(localId)) return;
            try {
                await recoverMaterializedLocalId(localId, { maxWaitMs: configuration.transcriptRecoveryMaxWaitMs });
            } catch (error) {
                if (error instanceof UnsupportedTranscriptLookupError) {
                    return;
                }
                throw error;
            }
        });
    };

    const forgetMaterializationRecovery = (localId: string): void => {
        materializationRecoveryScheduler.cancel(localId);
        transcriptRecoveryErrorStateByLocalId.delete(localId);
    };

    return {
        catchUpSessionMessages,
        scheduleNextStartupMessageCatchUpRetry,
        clearStartupMessageCatchUpRetryTimer,
        syncChangesOnConnect,
        recoverMaterializedLocalId,
        scheduleMaterializationRecovery,
        forgetMaterializationRecovery,
        stopStaleSafety: () => staleSafetyScheduler.stop(),
    };
}

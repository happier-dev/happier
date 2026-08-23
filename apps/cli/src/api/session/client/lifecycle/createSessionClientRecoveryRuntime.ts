import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { logger } from '@/ui/logger';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import type { Update } from '../../../types';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { catchUpSessionMessagesAfterSeq } from '../../sessionMessageCatchUp';
import {
    isV2ChangesSyncEnabled,
    runSessionChangesSyncOnConnect,
    type SessionCatchUpRequest,
} from '../../sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../../../changes';
import { readAccountChangesCursor } from '@/persistence';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';

export type SessionClientRecoveryRuntime = Readonly<{
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    scheduleNextStartupMessageCatchUpRetry: () => void;
    clearStartupMessageCatchUpRetryTimer: () => void;
    syncChangesOnConnect: (opts: { reason: 'connect' | 'reconnect' }) => Promise<void>;
    getAccountId: () => Promise<string | null>;
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
        handleUpdate: (update: Update, opts: { source: 'session-scoped' | 'user-scoped' }) => void;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<boolean>;
        applyPendingQueueState: (state: KnownPendingQueueState) => void;
        refreshAccountSettingsForMinimumVersion?: (settingsVersion: number | null) => Promise<void>;
    }>,
): SessionClientRecoveryRuntime {
    let accountIdPromise: Promise<string> | null = null;
    let changesSyncInFlight: Promise<void> | null = null;
    const sessionChangesCursorByAccountId = new Map<string, number>();
    let startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const catchUpSessionMessages = async (catchUpRequest: SessionCatchUpRequest): Promise<void> => {
        const request = () => catchUpSessionMessagesAfterSeq({
            token: params.token,
            sessionId: params.sessionId,
            afterSeq: catchUpRequest.afterSeq,
            onUpdate: (update) => params.handleUpdate(update, {
                source: 'session-scoped',
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
            void catchUpSessionMessages({
                afterSeq: params.getStartupMessageCatchUpInitialAfterSeq(),
            })
                .then(() => true, (error) => {
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

    const readSessionChangesCursor = async (accountId: string): Promise<number> => {
        const existing = sessionChangesCursorByAccountId.get(accountId);
        if (typeof existing === 'number' && Number.isSafeInteger(existing) && existing >= 0) {
            return existing;
        }

        let initialCursor = 0;
        try {
            initialCursor = await readAccountChangesCursor(accountId);
        } catch {
            initialCursor = 0;
        }
        const normalized = Number.isSafeInteger(initialCursor) && initialCursor >= 0 ? initialCursor : 0;
        sessionChangesCursorByAccountId.set(accountId, normalized);
        return normalized;
    };

    const writeSessionChangesCursor = async (accountId: string, cursor: number): Promise<void> => {
        const normalized = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
        const existing = sessionChangesCursorByAccountId.get(accountId) ?? 0;
        if (normalized > existing) {
            sessionChangesCursorByAccountId.set(accountId, normalized);
        }
    };

    const syncChangesOnConnect = async (opts: { reason: 'connect' | 'reconnect' }): Promise<void> => {
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
            readChangesCursor: readSessionChangesCursor,
            writeChangesCursor: writeSessionChangesCursor,
            catchUpSessionMessages: (request) => catchUpSessionMessages(request),
            syncSessionSnapshotFromServer: (syncOpts) => params.syncSessionSnapshotFromServer(syncOpts),
            applyPendingQueueState: (state) => params.applyPendingQueueState(state),
            refreshAccountSettingsForMinimumVersion: params.refreshAccountSettingsForMinimumVersion,
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
    };

    return {
        catchUpSessionMessages,
        scheduleNextStartupMessageCatchUpRetry,
        clearStartupMessageCatchUpRetryTimer,
        syncChangesOnConnect,
        getAccountId,
    };
}

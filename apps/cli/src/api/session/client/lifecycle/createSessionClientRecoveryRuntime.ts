import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { logger } from '@/ui/logger';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import type { Update } from '../../../types';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { catchUpSessionMessagesAfterSeq } from '../../sessionMessageCatchUp';
import {
    isV2ChangesSyncEnabled,
    runSessionChangesSyncOnConnect,
    type SessionCatchUpRequest,
} from '../../sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../../../changes';
import { readAccountChangesCursor } from '@/persistence';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

export type SessionClientRecoveryRuntime = Readonly<{
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    syncChangesOnConnect: (opts: { reason: 'connect' | 'reconnect' | 'live' }) => Promise<void>;
    getAccountId: () => Promise<string | null>;
}>;

export function createSessionClientRecoveryRuntime(
    params: Readonly<{
        token: string;
        env?: NodeJS.ProcessEnv;
        serverUrl?: string;
        accountChangesEnabled?: boolean;
        sessionId: string;
        getClosed: () => boolean;
        getSessionConnectionSupervisor: () => ManagedConnectionSupervisor | null;
        getLastObservedMessageSeq: () => number;
        handleUpdate: (update: Update, opts: { source: 'session-scoped' | 'user-scoped' }) => void;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<boolean>;
        applyPendingQueueState: (state: KnownPendingQueueState) => void;
        reconcilePendingExecutionRunTarget?: (runId: string) => Promise<void>;
        refreshAccountSettingsForMinimumVersion?: (settingsVersion: number | null) => Promise<void>;
        refreshDemandedAccountCatalogs?: () => Promise<void>;
        onSessionFollowInvalidated?: () => void;
    }> & SessionStoredContentCryptoContext,
): SessionClientRecoveryRuntime {
    const env = params.env ?? sessionProcessEnvironment();
    const serverUrl = params.serverUrl ?? resolveServerHttpBaseUrl();
    let accountIdPromise: Promise<string> | null = null;
    let changesSyncInFlight: Promise<void> | null = null;
    let liveChangesPending = false;
    const sessionChangesCursorByAccountId = new Map<string, number>();
    const catchUpSessionMessages = async (catchUpRequest: SessionCatchUpRequest): Promise<void> => {
        const request = () => runWithServerHttpBaseUrl(serverUrl, () => catchUpSessionMessagesAfterSeq({
            ...(params.mode === 'plain' ? { mode: 'plain' as const, ctx: null } : { mode: 'e2ee' as const, ctx: params.ctx }),
            token: params.token,
            sessionId: params.sessionId,
            afterSeq: catchUpRequest.afterSeq,
            onUpdate: (update) => params.handleUpdate(update, {
                source: 'session-scoped',
            }),
        }));
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

    const getAccountId = async (): Promise<string | null> => {
        if (params.accountChangesEnabled === false) return null;
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

        const request = () => runWithServerHttpBaseUrl(serverUrl, () => fetchChangesAccountId({ token: params.token }));
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

    const syncChangesOnConnect = async (opts: { reason: 'connect' | 'reconnect' | 'live' }): Promise<void> => {
        if (params.accountChangesEnabled !== false && !isV2ChangesSyncEnabled(env.HAPPY_ENABLE_V2_CHANGES)) {
            if (opts.reason === 'live' && !params.getClosed()) {
                params.onSessionFollowInvalidated?.();
                await params.refreshDemandedAccountCatalogs?.();
            }
            return;
        }

        if (params.getClosed()) return;
        if (changesSyncInFlight) {
            if (opts.reason === 'live') {
                // A hint may describe a write after the active read began.
                // Keep one follow-up on this owner rather than one read per waiter.
                liveChangesPending = true;
                await changesSyncInFlight;
                return;
            }
            await changesSyncInFlight.catch(() => {});
        }

        // A scoped Session has no Account change cursor. The existing exact
        // transcript/snapshot recovery owners reconstruct its projection.
        const sync = (reason: 'connect' | 'reconnect' | 'live') => params.accountChangesEnabled === false
            ? (async () => {
                if (reason === 'reconnect') {
                    await catchUpSessionMessages({ afterSeq: params.getLastObservedMessageSeq() });
                }
                await params.syncSessionSnapshotFromServer({ reason: reason === 'live' ? 'explicit-drain' : reason });
            })()
            : runWithServerHttpBaseUrl(serverUrl, () => runSessionChangesSyncOnConnect({
            reason,
            token: params.token,
            sessionId: params.sessionId,
            lastObservedMessageSeq: params.getLastObservedMessageSeq(),
            getAccountId,
            readChangesCursor: readSessionChangesCursor,
            writeChangesCursor: writeSessionChangesCursor,
            catchUpSessionMessages: (request) => catchUpSessionMessages(request),
            syncSessionSnapshotFromServer: (syncOpts) => params.syncSessionSnapshotFromServer(syncOpts),
            applyPendingQueueState: (state) => params.applyPendingQueueState(state),
            reconcilePendingExecutionRunTarget: params.reconcilePendingExecutionRunTarget,
            refreshAccountSettingsForMinimumVersion: params.refreshAccountSettingsForMinimumVersion,
            refreshDemandedAccountCatalogs: params.refreshDemandedAccountCatalogs,
            onSessionFollowInvalidated: params.onSessionFollowInvalidated,
            connectionSupervisor: params.getSessionConnectionSupervisor(),
            onDebug: (message, data) => logger.debug(message, data),
        }));

        const pending = (async () => {
            let reason = opts.reason;
            do {
                liveChangesPending = false;
                await sync(reason);
                reason = 'live';
            } while (liveChangesPending && !params.getClosed());
        })();

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
        syncChangesOnConnect,
        getAccountId,
    };
}

import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { fetchChanges } from '../changes';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { readSessionTranscriptChangeHintV1 } from '@happier-dev/protocol/changes';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { readKnownPendingQueueState, readPendingExecutionRunIds, type KnownPendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { parsePromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {
    publishPluginAccountSettingsWatchInvalidation,
    readPluginAccountSettingsWatchInvalidations,
} from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';

export type SessionCatchUpRequest = Readonly<{
    afterSeq: number;
}>;

export function isV2ChangesSyncEnabled(flagValue: string | undefined): boolean {
    if (!flagValue) return true;
    return ['true', '1', 'yes'].includes(flagValue.toLowerCase());
}

function reportReconnectCatchUpFailure(params: { onDebug: (message: string, data?: unknown) => void }, error: unknown): void {
    params.onDebug('[API] Failed to catch up session messages after reconnect', {
        error: serializeAxiosErrorForLog(error),
    });
}

function snapshotReasonForChangesFallback(reason: 'connect' | 'reconnect' | 'live'): SessionSnapshotRefreshReason {
    return reason === 'live' ? 'explicit-drain' : reason;
}

type ChangesPage = Awaited<ReturnType<typeof fetchChanges>>;
const inFlightChangesPages = new Map<string, Promise<ChangesPage>>();

/**
 * One Account wake reaches every Session client of a session host at once (one shared Account
 * update connection). Clients at the same cursor share the one in-flight page read; each still
 * applies the page to its own Session and cursor. Only in-flight reads are shared (no cache), and
 * a read settles on its own request timeout.
 */
function fetchSessionChangesPage(request: Readonly<{ token: string; after: number; limit: number }>): Promise<ChangesPage> {
    const key = `${resolveServerHttpBaseUrl()}\n${request.token}\n${request.after}\n${request.limit}`;
    const existing = inFlightChangesPages.get(key);
    if (existing) return existing;
    const read = fetchChanges(request).finally(() => { inFlightChangesPages.delete(key); });
    inFlightChangesPages.set(key, read);
    return read;
}

export async function runSessionChangesSyncOnConnect(params: {
    reason: 'connect' | 'reconnect' | 'live';
    token: string;
    sessionId: string;
    lastObservedMessageSeq: number;
    getAccountId: () => Promise<string | null>;
    readChangesCursor: (accountId: string) => Promise<number>;
    writeChangesCursor: (accountId: string, cursor: number) => Promise<void>;
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<boolean>;
    applyPendingQueueState?: ((state: KnownPendingQueueState) => void) | null;
    reconcilePendingExecutionRunTarget?: ((runId: string) => Promise<void>) | null;
    refreshAccountSettingsForMinimumVersion?: (settingsVersion: number | null) => Promise<void>;
    refreshDemandedAccountCatalogs?: () => Promise<void>;
    onSessionFollowInvalidated?: () => void;
    connectionSupervisor?: ManagedConnectionSupervisor | null;
    onDebug: (message: string, data?: unknown) => void;
}): Promise<void> {
    const requestSupervisionScope = params.connectionSupervisor?.captureProbeReportScope?.();
    const accountId = await params.getAccountId();
    if (!accountId) {
        if (params.reason === 'live') params.onSessionFollowInvalidated?.();
        return;
    }
    const refreshDemandedAccountCatalogs = async () => {
        try { await params.refreshDemandedAccountCatalogs?.(); }
        catch { params.onDebug('[API] Demanded Account catalog refresh unavailable'); }
    };

    const CHANGES_PAGE_LIMIT = 200;
    const after = await params.readChangesCursor(accountId);
    const result = await fetchSessionChangesPage({ token: params.token, after, limit: CHANGES_PAGE_LIMIT });
    if (result.status === 'cursor-gone') {
        params.onSessionFollowInvalidated?.();
        let transcriptCatchUpSucceeded = true;
        // If the server indicates the cursor is invalid (future cursor or pruned floor),
        // force a snapshot rebuild so we don't miss deletion signals.
        if (params.reason !== 'connect') {
            try {
                await params.catchUpSessionMessages({
                    afterSeq: params.lastObservedMessageSeq,
                });
            } catch (error) {
                transcriptCatchUpSucceeded = false;
                reportReconnectCatchUpFailure(params, error);
            }
        }
        await params.refreshAccountSettingsForMinimumVersion?.(null);
        await refreshDemandedAccountCatalogs();
        publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
        const snapshotSucceeded = await params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        if (transcriptCatchUpSucceeded && snapshotSucceeded) {
            await params.writeChangesCursor(accountId, result.currentCursor);
        }
        return;
    }
    if (result.status !== 'ok') {
        if (handleRequestAuthenticationFailure({
            supervisor: params.connectionSupervisor,
            error: result.error,
            hadAuth: true,
            scope: requestSupervisionScope,
        })) {
            return;
        }
        // Without change details, retain the previous conservative recovery.
        if (params.reason === 'live') params.onSessionFollowInvalidated?.();

        // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
        // On reconnect, fall back to the snapshot-based convergence path.
        if (params.reason !== 'connect') {
            try {
                await params.catchUpSessionMessages({
                    afterSeq: params.lastObservedMessageSeq,
                });
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
            await params.refreshAccountSettingsForMinimumVersion?.(null);
            await refreshDemandedAccountCatalogs();
            await params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        }
        return;
    }

    const changes = result.response.changes;
    const nextCursor = result.response.nextCursor;
    const pluginAccountSettingsInvalidations = readPluginAccountSettingsWatchInvalidations(changes);
    const accountSettingsVersions = changes
        .filter((change) => change.kind === 'account' && change.entityId === 'self')
        .map((change) => readAccountSettingsVersionFromHint(change.hint))
        .filter((version): version is number => version !== null);
    const highestAccountSettingsVersion = accountSettingsVersions.length > 0
        ? Math.max(...accountSettingsVersions)
        : null;

    // Settings convergence precedes Pending publication and cursor acknowledgement.
    if (highestAccountSettingsVersion !== null) {
        await params.refreshAccountSettingsForMinimumVersion?.(highestAccountSettingsVersion);
    } else if (params.reason === 'reconnect' || changes.length >= CHANGES_PAGE_LIMIT) {
        await params.refreshAccountSettingsForMinimumVersion?.(null);
    }
    if (params.reason === 'reconnect' || highestAccountSettingsVersion !== null || changes.length >= CHANGES_PAGE_LIMIT
        || changes.some(change => change.kind === 'account' && (change.entityId === MCP_SERVER_CATALOG_ACCOUNT_KEY_V1
            || parsePromptLibraryPhysicalKeyV1(change.entityId) !== null))) {
        await refreshDemandedAccountCatalogs();
    }
    if (changes.length >= CHANGES_PAGE_LIMIT) {
        publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
    } else {
        for (const invalidation of pluginAccountSettingsInvalidations) {
            publishPluginAccountSettingsWatchInvalidation(invalidation);
        }
    }

    let transcriptCatchUpFailed = false;
    let snapshotSyncFailed = false;
    const catchUpSessionMessages = async (request: SessionCatchUpRequest): Promise<void> => {
        try {
            await params.catchUpSessionMessages(request);
        } catch (error) {
            transcriptCatchUpFailed = true;
            reportReconnectCatchUpFailure(params, error);
        }
    };

    let hasRelevantSessionChange = false;
    let shouldCatchUpSessionMessages = false;
    let shouldSyncSnapshotFallback = false;
    const pendingExecutionRunIds = new Set<string>();
    for (const change of changes) {
        const isRelevant = (change.kind === 'session' || change.kind === 'share') && change.entityId === params.sessionId;
        if (!isRelevant) continue;
        hasRelevantSessionChange = true;
        if (change.kind === 'session') {
            for (const runId of readPendingExecutionRunIds(change.hint) ?? []) {
                pendingExecutionRunIds.add(runId);
            }
        }
        if (change.kind === 'share') {
            shouldSyncSnapshotFallback = params.reason !== 'connect';
            continue;
        }
        const pendingQueueState = readKnownPendingQueueState(change.hint);
        if (pendingQueueState) {
            params.applyPendingQueueState?.(pendingQueueState);
            continue;
        }
        const messageChange = readSessionTranscriptChangeHintV1(change);
        if (messageChange) {
            if (params.reason !== 'connect' && messageChange.seq > params.lastObservedMessageSeq) {
                shouldCatchUpSessionMessages = true;
            }
            continue;
        }
        shouldSyncSnapshotFallback = params.reason !== 'connect';
    }
    await Promise.all([...pendingExecutionRunIds].map(async (runId) => {
        await params.reconcilePendingExecutionRunTarget?.(runId);
    }));
    if (changes.length >= CHANGES_PAGE_LIMIT) {
        params.onSessionFollowInvalidated?.();
        // Slow-path: too many coalesced changes. Snapshot sync gets us back to a known-good state;
        // session transcript catch-up is only needed after reconnect.
        if (params.reason === 'reconnect') {
            await catchUpSessionMessages({
                afterSeq: params.lastObservedMessageSeq,
            });
        }
        const snapshotSucceeded = await params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        if (!transcriptCatchUpFailed && snapshotSucceeded) {
            await params.writeChangesCursor(accountId, nextCursor);
        }
        return;
    }

    if (hasRelevantSessionChange && params.reason === 'reconnect') {
        await catchUpSessionMessages({
            afterSeq: params.lastObservedMessageSeq,
        });
        const snapshotSucceeded = await params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        snapshotSyncFailed = !snapshotSucceeded;
    }

    if (shouldCatchUpSessionMessages && params.reason !== 'reconnect') {
        await catchUpSessionMessages({
            afterSeq: params.lastObservedMessageSeq,
        });
    }

    if (shouldSyncSnapshotFallback) {
        const snapshotSucceeded = await params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        snapshotSyncFailed = snapshotSyncFailed || !snapshotSucceeded;
    }

    // Follow source changes publish a change for each destination; workflow
    // delivery publishes one for its origin. Unrelated Account activity cannot
    // produce context for this Session. Exact socket hints still wake directly.
    if (hasRelevantSessionChange) params.onSessionFollowInvalidated?.();

    if (!transcriptCatchUpFailed && !snapshotSyncFailed) {
        await params.writeChangesCursor(accountId, nextCursor);
    }
}

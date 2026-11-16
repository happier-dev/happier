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

/** The change kinds `runSessionChangesSyncOnConnect` reads: Account rows (Settings, catalogs), plugin
 * Settings records, and the Session's own `session` / `share` rows. */
const SESSION_CLIENT_CHANGE_KINDS: ReadonlySet<unknown> = new Set(['account', 'pluginDomain', 'session', 'share']);

/**
 * Whether a live Account wake needs this Session client's changes read. The client consumes only
 * Account rows (Settings, catalogs, plugin settings), share rows and changes to its own Session.
 * Another Session's row has no consumer here (its per-client cursor keeps it for a later read), and
 * an own-Session change whose row facts the server declares pushed to the Session audience
 * (`rowFactsPushedSessionId`: current-view and pending-state writes) is applied through this
 * client's live Session socket. A kind this client never reads (`machine`, recipient access, …)
 * has no consumer either. Wakes without complete routing, and every other consumed kind, read.
 */
export function accountWakeNeedsSessionChangesRead(params: Readonly<{
    wake: unknown; sessionId: string; sessionPushesCurrent: boolean;
}>): boolean {
    const body = params.wake && typeof params.wake === 'object' && 'body' in params.wake ? params.wake.body : null;
    if (!body || typeof body !== 'object' || !('t' in body) || body.t !== 'account-change') return true;
    const routing = body as Readonly<{ changeKinds?: unknown; entityIds?: unknown; rowFactsPushedSessionId?: unknown }>;
    if (!Array.isArray(routing.changeKinds) || !Array.isArray(routing.entityIds) || routing.changeKinds.length === 0) return true;
    const consumedKinds = routing.changeKinds.filter(kind => SESSION_CLIENT_CHANGE_KINDS.has(kind));
    if (consumedKinds.length === 0) return false;
    if (consumedKinds.some(kind => kind !== 'session')) return true;
    if (!routing.entityIds.includes(params.sessionId)) return false;
    return !(params.sessionPushesCurrent && routing.rowFactsPushedSessionId === params.sessionId);
}

export type AccountWakeConsumer = Readonly<{
    sessionId: string;
    /** This client currently receives its Account stream's wakes (its Account update view is attached). */
    receivesWakes: () => boolean;
    sessionPushesCurrent: () => boolean;
}>;

/**
 * Per Account stream (credential) in this process: its live Session clients, and the last wake it
 * delivered with the feed pages read for that wake. A session host fans one wake object out to every
 * Session client of the stream (`sharedAccountUpdatesSocket`), so the wake object identifies the wake.
 */
type AccountWakeStream = { consumers: Set<AccountWakeConsumer>; wake: object | null; pages: Map<string, Promise<ChangesPage>> };
const accountWakeStreams = new Map<string, AccountWakeStream>();

/** One Session client consumes its Account stream's wakes in this process until the returned release. */
export function registerAccountWakeConsumer(token: string, consumer: AccountWakeConsumer): () => void {
    let stream = accountWakeStreams.get(token);
    if (!stream) accountWakeStreams.set(token, stream = { consumers: new Set(), wake: null, pages: new Map() });
    const registered = stream;
    registered.consumers.add(consumer);
    return () => {
        registered.consumers.delete(consumer);
        if (registered.consumers.size === 0 && accountWakeStreams.get(token) === registered) accountWakeStreams.delete(token);
    };
}

/**
 * Whether a live Account wake needs a changes read by this process's Session clients of that Account
 * stream. A session host reads each Account's feed once per wake: when any of its Sessions needs the
 * wake (`accountWakeNeedsSessionChangesRead`), every Session client receiving it reads and clients at
 * the same cursor get the one page read for this wake (`fetchSessionChangesPage`), so their cursors
 * stay together and the next wake is again one read. When none needs it, none reads. A process with
 * one Session client (a runner) decides exactly as that client alone.
 */
export function accountWakeNeedsHostChangesRead(params: Readonly<{ wake: unknown; token: string }>): boolean {
    const stream = accountWakeStreams.get(params.token);
    if (!stream) return false;
    if (params.wake && typeof params.wake === 'object' && stream.wake !== params.wake) {
        // A new wake: pages read for the previous one no longer cover what this wake announces.
        stream.wake = params.wake;
        stream.pages = new Map();
    }
    for (const consumer of stream.consumers) {
        if (consumer.receivesWakes() && accountWakeNeedsSessionChangesRead({ wake: params.wake,
            sessionId: consumer.sessionId, sessionPushesCurrent: consumer.sessionPushesCurrent() })) return true;
    }
    return false;
}
const inFlightChangesPages = new Map<string, Promise<ChangesPage>>();

/**
 * Clients at the same cursor share one page read. Connect and reconnect reads share only an in-flight
 * read (a missed wake must never be covered by an older page). A live read shares the page already
 * read for the stream's current wake: it covers every change that wake announced, and any later
 * change arrives with a new wake, which starts a fresh read. A failed read is never shared after it
 * settles; every read settles on its own request timeout.
 */
function fetchSessionChangesPage(request: Readonly<{ token: string; after: number; limit: number; live: boolean }>): Promise<ChangesPage> {
    const key = `${resolveServerHttpBaseUrl()}\n${request.token}\n${request.after}\n${request.limit}`;
    const wakePages = request.live ? accountWakeStreams.get(request.token)?.pages : undefined;
    const existing = wakePages?.get(key) ?? inFlightChangesPages.get(key);
    if (existing) return existing;
    const read = fetchChanges({ token: request.token, after: request.after, limit: request.limit })
        .finally(() => { inFlightChangesPages.delete(key); });
    inFlightChangesPages.set(key, read);
    if (wakePages) {
        wakePages.set(key, read);
        void read.then(page => { if (page.status !== 'ok') wakePages.delete(key); }, () => { wakePages.delete(key); });
    }
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
    const result = await fetchSessionChangesPage({ token: params.token, after, limit: CHANGES_PAGE_LIMIT,
        live: params.reason === 'live' });
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

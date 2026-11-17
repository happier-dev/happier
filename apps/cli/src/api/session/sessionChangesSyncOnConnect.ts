import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { fetchChanges } from '../changes';
import { refreshCliActionAutomationsFromChangesV1 } from '../actionAutomations';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import {
    isChangesPageFull, projectPushedChangesPageAt, PushedAccountChangesPageV1Schema, readSessionTranscriptChangeHintV1,
    type ChangeKind, type ChangesResponse, type PushedAccountChangesPageV1,
} from '@happier-dev/protocol/changes';
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
 * Settings records, Action automation index rows, and the Session's own `session` / `share` rows. The Account updates socket declares
 * them as its change-row demand, so its wakes carry exactly these rows. */
export const SESSION_CLIENT_ACCOUNT_CHANGE_KINDS = ['account', 'pluginDomain', 'session', 'share', 'automation', 'artifact'] as const satisfies readonly ChangeKind[];
const SESSION_CLIENT_CHANGE_KINDS: ReadonlySet<unknown> = new Set(SESSION_CLIENT_ACCOUNT_CHANGE_KINDS);

/** The wake's pushed page, parsed explicitly; absent or malformed is undefined and the wake keeps its routing only. */
function readWakePushedChangesPage(wake: unknown): PushedAccountChangesPageV1 | undefined {
    const body = wake && typeof wake === 'object' && 'body' in wake ? wake.body : null;
    if (!body || typeof body !== 'object' || !('rows' in body)) return undefined;
    const parsed = PushedAccountChangesPageV1Schema.safeParse(body.rows);
    return parsed.success ? parsed.data : undefined;
}

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
    // Pushed rows are the wake's whole content (including typed Settings rows its routing omits).
    const pushedRows = readWakePushedChangesPage(params.wake)?.page.changes ?? [];
    const changeKinds: unknown[] = [...routing.changeKinds, ...pushedRows.map(change => change.kind)];
    const entityIds: unknown[] = [...routing.entityIds, ...pushedRows.map(change => change.entityId)];
    const consumedKinds = changeKinds.filter(kind => SESSION_CLIENT_CHANGE_KINDS.has(kind));
    if (consumedKinds.length === 0) return false;
    if (consumedKinds.some(kind => kind !== 'session')) return true;
    if (!entityIds.includes(params.sessionId)) return false;
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
/** A pushed page held for one Session client until its next changes sync, with whether it has a consumer there. */
type HeldPushedChangesPage = Readonly<{ pushed: PushedAccountChangesPageV1; consumed: boolean }>;
type AccountWakeStream = { consumers: Set<AccountWakeConsumer>; wake: object | null; pages: Map<string, Promise<ChangesPage>>;
    pushed: Map<AccountWakeConsumer, HeldPushedChangesPage[]> };
const accountWakeStreams = new Map<string, AccountWakeStream>();

/** One Session client consumes its Account stream's wakes in this process until the returned release. */
export function registerAccountWakeConsumer(token: string, consumer: AccountWakeConsumer): () => void {
    let stream = accountWakeStreams.get(token);
    if (!stream) accountWakeStreams.set(token, stream = { consumers: new Set(), wake: null, pages: new Map(), pushed: new Map() });
    const registered = stream;
    registered.consumers.add(consumer);
    return () => {
        registered.consumers.delete(consumer);
        registered.pushed.delete(consumer);
        if (registered.consumers.size === 0 && accountWakeStreams.get(token) === registered) accountWakeStreams.delete(token);
    };
}

/**
 * Whether a live Account wake needs a changes sync by this process's Session clients of that Account
 * stream. A wake that carries its rows (the server authorized them for this socket's credential at
 * fan-out) is held for every Session client receiving it and synced from, with no read: a client with
 * no consumer for it only advances its cursor, so later wakes never find a gap. Otherwise a session
 * host reads each Account's feed once per wake: when any of its Sessions needs the wake
 * (`accountWakeNeedsSessionChangesRead`), every Session client receiving it reads and clients at the
 * same cursor get the one page read for this wake (`fetchSessionChangesPage`). When none needs it,
 * none reads. A process with one Session client (a runner) decides exactly as that client alone.
 */
export function accountWakeNeedsHostChangesRead(params: Readonly<{ wake: unknown; token: string }>): boolean {
    const stream = accountWakeStreams.get(params.token);
    if (!stream) return false;
    if (params.wake && typeof params.wake === 'object' && stream.wake !== params.wake) {
        // A new wake: pages read for the previous one no longer cover what this wake announces.
        stream.wake = params.wake;
        stream.pages = new Map();
        const pushed = readWakePushedChangesPage(params.wake);
        if (pushed) {
            for (const consumer of stream.consumers) {
                if (!consumer.receivesWakes()) continue;
                const held = stream.pushed.get(consumer) ?? [];
                held.push({ pushed, consumed: accountWakeNeedsSessionChangesRead({ wake: params.wake,
                    sessionId: consumer.sessionId, sessionPushesCurrent: consumer.sessionPushesCurrent() }) });
                stream.pushed.set(consumer, held);
            }
        }
    }
    for (const consumer of stream.consumers) {
        if (consumer.receivesWakes() && (stream.pushed.get(consumer)?.length ?? 0) > 0) return true;
    }
    for (const consumer of stream.consumers) {
        if (consumer.receivesWakes() && accountWakeNeedsSessionChangesRead({ wake: params.wake,
            sessionId: consumer.sessionId, sessionPushesCurrent: consumer.sessionPushesCurrent() })) return true;
    }
    return false;
}
const inFlightChangesPages = new Map<string, Promise<ChangesPage>>();

/**
 * The pushed rows a Session client at `after` applies: its held pages that continue from its cursor,
 * in order, as one page (`projectPushedChangesPageAt`). Null when it holds none at its cursor: a gap
 * the feed read covers when one of its held wakes has a consumer here, and nothing to do otherwise.
 * Pages its cursor already covers are dropped. This client ignores the Session access witness (the
 * daemon owns Session access), so a joined page carries none.
 */
function takeHeldPushedChangesPage(request: Readonly<{ token: string; sessionId: string; after: number }>):
    Readonly<{ page: ChangesResponse; full: boolean; consumed: boolean }> | Readonly<{ gap: true; consumed: boolean }>
    | Readonly<{ current: true }> | null {
    const stream = accountWakeStreams.get(request.token);
    const consumer = stream ? [...stream.consumers].find(entry => entry.sessionId === request.sessionId) : undefined;
    const held = consumer ? stream!.pushed.get(consumer) : undefined;
    if (!held || held.length === 0) {
        // A sync coalesced behind one that already applied the latest wake's rows has nothing to read.
        const latest = stream?.wake ? readWakePushedChangesPage(stream.wake) : undefined;
        return latest && latest.page.nextCursor <= request.after ? { current: true } : null;
    }
    let cursor = request.after;
    let joined: Readonly<{ changes: ChangesResponse['changes']; full: boolean; consumed: boolean }> | null = null;
    for (;;) {
        const index = held.findIndex(entry => projectPushedChangesPageAt(entry.pushed, cursor) !== null);
        if (index < 0 || joined?.full) break;
        const [entry] = held.splice(index, 1) as [HeldPushedChangesPage];
        const projected = projectPushedChangesPageAt(entry.pushed, cursor)!;
        joined = { changes: [...joined?.changes ?? [], ...projected.page.changes], full: projected.full,
            consumed: (joined?.consumed ?? false) || entry.consumed };
        cursor = projected.page.nextCursor;
    }
    const remaining = held.filter(entry => entry.pushed.page.nextCursor > cursor);
    const consumedRemaining = remaining.some(entry => entry.consumed);
    if (remaining.length === 0) stream!.pushed.delete(consumer!);
    else stream!.pushed.set(consumer!, remaining);
    if (!joined) return { gap: true, consumed: consumedRemaining || held.some(entry => entry.consumed) };
    return { page: { changes: joined.changes, nextCursor: cursor, full: joined.full }, full: joined.full, consumed: joined.consumed };
}

/** A connect or reconnect catch-up reads the feed: pages held before it are superseded. */
function dropHeldPushedChangesPages(token: string, sessionId: string): void {
    const stream = accountWakeStreams.get(token);
    const consumer = stream ? [...stream.consumers].find(entry => entry.sessionId === sessionId) : undefined;
    if (consumer) stream!.pushed.delete(consumer);
}

/**
 * Clients at the same cursor share one page read. Connect and reconnect reads share only an in-flight
 * read (a missed wake must never be covered by an older page). A live read shares the page already
 * read for the stream's current wake: it covers every change that wake announced, and any later
 * change arrives with a new wake, which starts a fresh read. A failed read is never shared after it
 * settles; every read settles on its own request timeout.
 */
function fetchSessionChangesPage(request: Readonly<{ token: string; after: number; limit: number; live: boolean;
    pushed?: ChangesResponse }>): Promise<ChangesPage> {
    const key = `${resolveServerHttpBaseUrl()}\n${request.token}\n${request.after}\n${request.limit}`;
    const wakePages = request.live ? accountWakeStreams.get(request.token)?.pages : undefined;
    const existing = wakePages?.get(key) ?? inFlightChangesPages.get(key);
    if (existing) return existing;
    const read = (request.pushed ? Promise.resolve({ status: 'ok' as const, response: request.pushed })
        : fetchChanges({ token: request.token, after: request.after, limit: request.limit }))
        .then(async result => {
            if (result.status === 'ok') await refreshCliActionAutomationsFromChangesV1({
                token: request.token, serverHttpBaseUrl: resolveServerHttpBaseUrl(), changes: result.response.changes,
            });
            return result;
        })
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
    if (params.reason !== 'live') dropHeldPushedChangesPages(params.token, params.sessionId);
    const held = params.reason === 'live'
        ? takeHeldPushedChangesPage({ token: params.token, sessionId: params.sessionId, after }) : null;
    if (held && 'current' in held) return;
    if (held && !held.consumed) {
        // Pushed rows this client has no consumer for advance its cursor with no read; such a gap waits
        // for a wake it consumes (as an unconsumed wake always did).
        if (!('gap' in held) && !held.full) await params.writeChangesCursor(accountId, held.page.nextCursor);
        if ('gap' in held || !held.full) return;
    }
    const result = await fetchSessionChangesPage({ token: params.token, after, limit: CHANGES_PAGE_LIMIT,
        live: params.reason === 'live', ...(held && !('gap' in held) ? { pushed: held.page } : {}) });
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
    // The server judges `full` on the rows it read; a page its filter shortened still reads on.
    const pageFull = isChangesPageFull(result.response, CHANGES_PAGE_LIMIT);
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
    } else if (params.reason === 'reconnect' || pageFull) {
        await params.refreshAccountSettingsForMinimumVersion?.(null);
    }
    if (params.reason === 'reconnect' || highestAccountSettingsVersion !== null || pageFull
        || changes.some(change => change.kind === 'account' && (change.entityId === MCP_SERVER_CATALOG_ACCOUNT_KEY_V1
            || parsePromptLibraryPhysicalKeyV1(change.entityId) !== null))) {
        await refreshDemandedAccountCatalogs();
    }
    if (pageFull) {
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
    if (pageFull) {
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

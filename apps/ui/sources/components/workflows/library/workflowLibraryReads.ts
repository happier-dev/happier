import * as React from 'react';
import { Dimensions } from 'react-native';
import { workflowRunStoreKey, workflowRunListWindowStoreKey, type WorkflowRunListWindowStoreId } from '@/sync/store/domains/workflowRuns';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { workflowDefinitionListCursorPhaseV1, type WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import {
    resolveWorkflowProblemPresentation,
    type WorkflowProblemPresentation,
} from '@/components/workflows/presentation/workflowProblemPresentation';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScopeLifetime, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { listAutomationDefinitionRuns } from '@/sync/api/automations/apiAutomationRuns';
import {
    isBeyondWorkflowRunListSpan,
    workflowRunRowFromAutomationRun,
    workflowRunRowFromSummary,
    workflowRunListFrontier,
    type WorkflowRunListWindowId,
} from '@/sync/store/domains/workflowRuns';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { listWorkflowDefinitions } from '@/sync/domains/workflows/workflowDefinitionActions';
import {
    buildWorkflowRunListFilter,
    listWorkflowRuns,
    type WorkflowRunListPage,
} from '@/sync/domains/workflows/workflowRunListActions';
import { subscribeVisibleWorkflowRunListInvalidation, type WorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { refreshWorkflowRunWindowChanges } from './workflowRunWindowChanges';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

/**
 * The Workflows destination's reads (FIN 04 §3.3). The column, library home and shared Runs list are
 * mounted together, so each read has one shared, Account-scoped owner here: concurrent mounts
 * collapse onto one request, a refresh keeps last-known rows, and an Account switch retires
 * everything the previous Account produced. Run rows land in the one Account-scoped Run store; this
 * module keeps only each window's read status, never a second copy of a Run.
 */

export type WorkflowLibraryReadStatus = 'loading' | 'loaded' | 'failed';

type ReadStatus = Readonly<{
    /** The Account that produced this status; a status from another Account is not shown. */
    scopeKey: string | null;
    status: WorkflowLibraryReadStatus;
    failure: WorkflowProblemPresentation | null;
    loadingMore: boolean;
    loadMoreFailed: boolean;
}>;

const INITIAL_STATUS: ReadStatus = Object.freeze({
    scopeKey: null,
    status: 'loading',
    failure: null,
    loadingMore: false,
    loadMoreFailed: false,
});

/** A tiny external store: one value, its listeners, and identity-preserving writes. */
function createCell<T>(initial: T) {
    let value = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => value,
        set(next: T) {
            if (Object.is(next, value)) return;
            value = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

// ---- saved definitions -------------------------------------------------------------------------

export type WorkflowLibraryDefinition = WorkflowDefinitionListResultV1['definitions'][number];

type DefinitionsState = ReadStatus & Readonly<{
    definitions: readonly WorkflowLibraryDefinition[];
    pluginWorkflows: readonly WorkflowPluginSourceV1[];
    nextCursor: string | null;
    loadedPages: number;
    deletedDefinitionId: string | null;
}>;

const INITIAL_DEFINITIONS: DefinitionsState = Object.freeze({
    ...INITIAL_STATUS,
    definitions: Object.freeze([]) as readonly WorkflowLibraryDefinition[],
    pluginWorkflows: Object.freeze([]) as readonly WorkflowPluginSourceV1[],
    nextCursor: null,
    loadedPages: 0,
    deletedDefinitionId: null,
});

function createDefinitionLibraryReader(captureLifetime: () => ServerAccountScopeLifetime | null, addressed = false) {
    const definitionsCell = createCell<DefinitionsState>(INITIAL_DEFINITIONS);
    let definitionsInFlight: { lifetime: ActiveServerAccountScopeLifetime; promise: Promise<void>; kind: 'refresh' | 'more'; refreshRequested: boolean; deletionInvalidated: boolean } | null = null;
    let definitionReaderCount = 0;
    let unsubscribeDefinitionChange: (() => void) | null = null;
    let deletionRetirement: Readonly<{ dispose(): void }> | null = null;

    /** The loaded Workflow domain retains acknowledgements, even before its first library demand. */
    function ensureDefinitionChangeObserver(): void {
        if (unsubscribeDefinitionChange === null) {
            unsubscribeDefinitionChange = subscribeHomeAccountChange((event) => {
                const lifetime = captureLifetime();
                if (lifetime === null || !areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
                // Session-only catch-up changes neither saved definitions nor
                // Machine-contributed workflows. Unknown wakes remain conservative.
                if (event.changeKinds?.length && event.changeKinds.every(kind => kind === 'session')) return;
                const deletedDefinitionId = event.deletedArtifactIds?.[0];
                if (deletedDefinitionId !== undefined) {
                    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
                    const cached = definitionsCell.get();
                    const current = cached.scopeKey === scopeKey ? cached : { ...INITIAL_DEFINITIONS, scopeKey };
                    definitionsCell.set({ ...current, deletedDefinitionId,
                        definitions: current.definitions.filter(row => !event.deletedArtifactIds?.includes(row.definitionId)) });
                    deletionRetirement?.dispose();
                    deletionRetirement = lifetime.onRetire(() => {
                        const latest = definitionsCell.get();
                        if (latest.scopeKey === scopeKey && latest.deletedDefinitionId !== null) {
                            definitionsCell.set({ ...latest, deletedDefinitionId: null });
                        }
                    });
                }
                // Artifact ids in the incumbent wake do not carry kind information.
                // The authoritative list decides membership, retaining equal known rows.
                if (definitionsInFlight?.lifetime === lifetime) {
                    definitionsInFlight.refreshRequested = true;
                    // Ordinary wakes queue a recheck without withholding usable rows.
                    // Only an acknowledged deletion makes the pending result obsolete.
                    if (deletedDefinitionId !== undefined) definitionsInFlight.deletionInvalidated = true;
                }
                else if (definitionReaderCount > 0) void refreshDefinitions();
            });
        }
    }

    // One observer belongs to the retained cache's module lifetime. It opens no transport
    // and demands no list without a reader; a cold editor can still publish its landing feedback.
    if (!addressed) ensureDefinitionChangeObserver();

    /** The rail, page and pickers share one demanded read and one Account wake observer. */
    function subscribeDefinitions(listener: () => void): () => void {
        const unsubscribe = definitionsCell.subscribe(listener);
        definitionReaderCount += 1;
        ensureDefinitionChangeObserver();
        return () => {
            unsubscribe();
            definitionReaderCount -= 1;
            if (addressed && definitionReaderCount === 0) {
                unsubscribeDefinitionChange?.(); unsubscribeDefinitionChange = null;
                deletionRetirement?.dispose(); deletionRetirement = null;
            }
            // The retained read cache still consumes acknowledged local deletions
            // while an editor is open; only mounted readers demand a refetch.
        };
    }

    function finishDefinitionRead(promise: Promise<void>, isCurrent: () => boolean): void {
        const read = definitionsInFlight;
        if (read?.promise !== promise) return;
        definitionsInFlight = null;
        // An invalidated plugin-discovery flight no longer owns any busy state,
        // including when the editor is the only mounted view and no refresh is demanded.
        if (read.deletionInvalidated && isCurrent()) {
            const current = definitionsCell.get();
            if (current.loadingMore) definitionsCell.set({ ...current, loadingMore: false });
        }
        if (read.refreshRequested && isCurrent() && definitionReaderCount > 0) void refreshDefinitions();
        else if (isCurrent() && definitionReaderCount > 0 && !definitionsCell.get().loadMoreFailed
            && workflowDefinitionListCursorPhaseV1(definitionsCell.get().nextCursor) === 'plugins-start') void loadMoreDefinitions();
    }

    function retainEqualLibraryRows<T>(previous: readonly T[], incoming: readonly T[], key: (row: T) => string): readonly T[] {
        const previousById = new Map(previous.map((row) => [key(row), row]));
        const rows = incoming.map((row) => {
            const stored = previousById.get(key(row));
            return stored !== undefined && sameStrictJsonValue(stored, row) ? stored : row;
        });
        return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
    }

    /** Refresh demanded Account pages together, then discover plugins without gating saved rows. */
    function refreshDefinitions(): Promise<void> {
        if (definitionReaderCount === 0) return Promise.resolve();
        const lifetime = captureLifetime();
        if (lifetime === null) return Promise.resolve();
        const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
        // The same Home/Account can reactivate while its retired request is still pending.
        // Only demand captured in this exact lifetime may join or queue behind that read.
        if (definitionsInFlight?.lifetime === lifetime) return definitionsInFlight.promise;
        const previous = definitionsCell.get();
        const demandedPages = previous.scopeKey === scopeKey ? Math.max(1, previous.loadedPages) : 1;
        // Another Account's rows are never shown while this one loads.
        if (previous.scopeKey !== scopeKey) definitionsCell.set({ ...INITIAL_DEFINITIONS, scopeKey });
        else if (previous.status === 'failed' || previous.loadingMore || previous.loadMoreFailed) definitionsCell.set({
            ...previous, status: previous.status === 'failed' ? 'loading' : previous.status, loadingMore: false, loadMoreFailed: false,
        });
        const readDefinitions = async (): Promise<void> => {
            let pluginContinuation: Readonly<{ cursor: string; loadedPages: number }> | null = null;
            try {
                let page = await listWorkflowDefinitions(addressed ? { accountLifetime: lifetime } : {});
                const definitions = new Map(page.definitions.map((row) => [row.definitionId, row]));
                const plugins = new Map((page.pluginWorkflows ?? []).map((row) => [row.workflow, row]));
                let loadedPages = 1;
                while (lifetime.isCurrent() && definitionReaderCount > 0 && !definitionsInFlight?.deletionInvalidated && page.nextCursor && (loadedPages < demandedPages
                    || (!pluginContinuation && workflowDefinitionListCursorPhaseV1(page.nextCursor) === 'plugins-start'))) {
                    if (!pluginContinuation && workflowDefinitionListCursorPhaseV1(page.nextCursor) !== 'artifacts') {
                        // Account content and built-ins remain usable while the daemon is
                        // pending. Same-Account refresh keeps last-known plugin rows until
                        // their authoritative continuation replaces them.
                        pluginContinuation = { cursor: page.nextCursor, loadedPages };
                        const current = definitionsCell.get();
                        const savedRows = retainEqualLibraryRows(current.definitions, [...definitions.values()], (row) => row.definitionId);
                        // Already-visible equal rows need no transient refresh notification.
                        if (!definitionsInFlight?.deletionInvalidated && (current.status !== 'loaded' || savedRows !== current.definitions)) definitionsCell.set({
                            ...current, scopeKey, status: 'loaded', failure: null, definitions: savedRows,
                            nextCursor: page.nextCursor, loadedPages, loadingMore: true, loadMoreFailed: false,
                        });
                    }
                    page = await listWorkflowDefinitions({ cursor: page.nextCursor, ...(addressed ? { accountLifetime: lifetime } : {}) });
                    for (const row of page.definitions) definitions.set(row.definitionId, row);
                    for (const row of page.pluginWorkflows ?? []) plugins.set(row.workflow, row);
                    loadedPages += 1;
                }
                if (!lifetime.isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                const current = definitionsCell.get();
                const next: DefinitionsState = {
                    scopeKey,
                    status: 'loaded',
                    failure: null,
                    loadingMore: false,
                    loadMoreFailed: false,
                    definitions: retainEqualLibraryRows(current.definitions, [...definitions.values()], (row) => row.definitionId),
                    pluginWorkflows: retainEqualLibraryRows(current.pluginWorkflows, [...plugins.values()], (row) => row.workflow),
                    nextCursor: page.nextCursor ?? null,
                    loadedPages,
                    deletedDefinitionId: current.deletedDefinitionId,
                };
                definitionsCell.set(sameStrictJsonValue(current, next) ? current : next);
            } catch (error) {
                if (!lifetime.isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                if (pluginContinuation) {
                    // Plugin failure must not turn readable Account rows into a failed
                    // initial load. Retry continues the same list phase.
                    definitionsCell.set({ ...definitionsCell.get(), nextCursor: pluginContinuation.cursor,
                        loadedPages: pluginContinuation.loadedPages, loadingMore: false, loadMoreFailed: true });
                    return;
                }
                // A failed refresh keeps what is already loaded and says why.
                definitionsCell.set({
                    ...definitionsCell.get(),
                    scopeKey,
                    status: 'failed',
                    failure: resolveWorkflowProblemPresentation(error),
                });
            } finally {
                finishDefinitionRead(promise, lifetime.isCurrent);
            }
        };
        const promise = readDefinitions();
        definitionsInFlight = { lifetime, promise, kind: 'refresh', refreshRequested: false, deletionInvalidated: false };
        return promise;
    }

    async function loadMoreDefinitions(): Promise<void> {
        if (definitionReaderCount === 0) return;
        const current = definitionsCell.get();
        const lifetime = captureLifetime();
        if (lifetime === null || current.nextCursor === null) return;
        const cursor = current.nextCursor;
        const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
        if (current.scopeKey !== scopeKey) return;
        const pending = definitionsInFlight;
        if (pending && pending.lifetime !== lifetime) {
            await refreshDefinitions();
            return;
        }
        if (current.loadingMore) return;
        if (pending?.lifetime === lifetime) {
            await pending.promise;
            if (pending.kind === 'refresh' && lifetime.isCurrent()) await loadMoreDefinitions();
            return;
        }
        definitionsCell.set({ ...current, loadingMore: true, loadMoreFailed: false });
        const readPage = async () => {
            try {
                const page = await listWorkflowDefinitions({ cursor, ...(addressed ? { accountLifetime: lifetime } : {}) });
                if (!lifetime.isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                const latest = definitionsCell.get();
                const seen = new Set(latest.definitions.map((entry) => entry.definitionId));
                const addedDefinitions = page.definitions.filter((entry) => !seen.has(entry.definitionId));
                const replacingPlugins = workflowDefinitionListCursorPhaseV1(cursor) === 'plugins-start';
                const seenPlugins = new Set(replacingPlugins ? [] : latest.pluginWorkflows.map((entry) => entry.workflow));
                const addedPlugins = (page.pluginWorkflows ?? []).filter((entry) => {
                    if (seenPlugins.has(entry.workflow)) return false;
                    seenPlugins.add(entry.workflow);
                    return true;
                });
                definitionsCell.set({
                    ...latest,
                    loadingMore: false,
                    definitions: addedDefinitions.length === 0 ? latest.definitions : [...latest.definitions, ...addedDefinitions],
                    pluginWorkflows: replacingPlugins
                        ? retainEqualLibraryRows(latest.pluginWorkflows, addedPlugins, (row) => row.workflow)
                        : addedPlugins.length === 0 ? latest.pluginWorkflows : [...latest.pluginWorkflows, ...addedPlugins],
                    nextCursor: page.nextCursor ?? null,
                    loadedPages: latest.loadedPages + 1,
                });
            } catch {
                // The loaded rows and the cursor stay; Retry asks for exactly this page again.
                if (lifetime.isCurrent() && !definitionsInFlight?.deletionInvalidated) definitionsCell.set({ ...definitionsCell.get(), loadingMore: false, loadMoreFailed: true });
            } finally {
                finishDefinitionRead(promise, lifetime.isCurrent);
            }
        };
        const promise = readPage();
        definitionsInFlight = { lifetime, promise, kind: 'more', refreshRequested: false, deletionInvalidated: false };
        await promise;
    }

    return {
        cell: definitionsCell, subscribe: subscribeDefinitions,
        refresh: refreshDefinitions,
        retry: () => { void refreshDefinitions(); },
        loadMore: () => { void loadMoreDefinitions(); },
        dismissDeletion(definitionId: string) {
            const current = definitionsCell.get();
            if (current.deletedDefinitionId !== definitionId) return;
            definitionsCell.set({ ...current, deletedDefinitionId: null });
            deletionRetirement?.dispose(); deletionRetirement = null;
        },
        reset() {
            unsubscribeDefinitionChange?.(); unsubscribeDefinitionChange = null;
            deletionRetirement?.dispose(); deletionRetirement = null;
            definitionsCell.set(INITIAL_DEFINITIONS); definitionsInFlight = null;
            ensureDefinitionChangeObserver();
        },
    };
}

const activeDefinitionLibrary = createDefinitionLibraryReader(captureActiveServerAccountScopeLifetime);
let addressedDefinitionLibraries = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createDefinitionLibraryReader>>();
function definitionLibraryForLifetime(lifetime: ServerAccountScopeLifetime | null | undefined) {
    if (!lifetime) return activeDefinitionLibrary;
    if (areServerAccountScopesEqual(lifetime.scope, captureActiveServerAccountScopeLifetime()?.scope)) return activeDefinitionLibrary;
    let reader = addressedDefinitionLibraries.get(lifetime);
    if (!reader) {
        reader = createDefinitionLibraryReader(() => lifetime.isCurrent() ? lifetime : null, true);
        addressedDefinitionLibraries.set(lifetime, reader);
    }
    return reader;
}

export type WorkflowDefinitionLibrary = Readonly<{
    status: WorkflowLibraryReadStatus;
    failure: WorkflowProblemPresentation | null;
    definitions: readonly WorkflowLibraryDefinition[];
    pluginWorkflows: readonly WorkflowPluginSourceV1[];
    deletedDefinitionId: string | null;
    hasMore: boolean;
    loadingMore: boolean;
    loadMoreFailed: boolean;
    retry: () => void;
    loadMore: () => void;
}>;

/** The landing view owns how long its local acknowledgement remains visible. */
export function dismissWorkflowLibraryDeletionReceipt(definitionId: string): void {
    activeDefinitionLibrary.dismissDeletion(definitionId);
}

const retryDefinitions = activeDefinitionLibrary.retry;
const requestMoreDefinitions = activeDefinitionLibrary.loadMore;
const subscribeInactiveDefinitions = (_listener: () => void) => () => {};
const readInactiveDefinitions = () => INITIAL_DEFINITIONS;
const INACTIVE_DEFINITION_LIBRARY: WorkflowDefinitionLibrary = Object.freeze({
    status: 'loading', failure: null,
    definitions: INITIAL_DEFINITIONS.definitions, pluginWorkflows: INITIAL_DEFINITIONS.pluginWorkflows,
    hasMore: false, loadingMore: false, loadMoreFailed: false,
    deletedDefinitionId: null,
    retry: retryDefinitions, loadMore: requestMoreDefinitions,
});

/** The saved definitions, refreshed when a surface that shows them mounts or the Account changes. */
export function useWorkflowDefinitionLibrary(options?: Readonly<{ enabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>): WorkflowDefinitionLibrary {
    const addressedLifetime = useWorkflowAccountLifetime(options?.accountLifetime);
    const enabled = options?.enabled ?? true;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const reader = definitionLibraryForLifetime(addressedLifetime);
    const readable = enabled && (addressedLifetime === undefined || lifetime?.isCurrent() === true);
    const scopeKey = lifetime === null ? null : serverAccountScopeKeySuffix(lifetime.scope);
    const state = React.useSyncExternalStore(
        readable ? reader.subscribe : subscribeInactiveDefinitions,
        readable ? reader.cell.get : readInactiveDefinitions,
        readable ? reader.cell.get : readInactiveDefinitions,
    );
    React.useEffect(() => { if (readable && lifetime) void reader.refresh(); }, [readable, lifetime, reader]);
    if (!enabled) return INACTIVE_DEFINITION_LIBRARY;
    const owned = state.scopeKey === scopeKey;
    return {
        status: owned ? state.status : 'loading',
        failure: owned ? state.failure : null,
        definitions: owned ? state.definitions : INITIAL_DEFINITIONS.definitions,
        pluginWorkflows: owned ? state.pluginWorkflows : INITIAL_DEFINITIONS.pluginWorkflows,
        deletedDefinitionId: owned ? state.deletedDefinitionId : null,
        hasMore: owned && state.nextCursor !== null,
        loadingMore: owned && state.loadingMore,
        loadMoreFailed: owned && state.loadMoreFailed,
        retry: reader.retry,
        loadMore: reader.loadMore,
    };
}

/** Resolve one plugin source through the same scoped pages as the library and pickers. */
export function useWorkflowPluginSource(workflow: string | null, enabled = true, accountLifetime?: ServerAccountScopeLifetime | null): Readonly<{
    source: WorkflowPluginSourceV1 | null;
    status: 'idle' | 'loading' | 'failed' | 'missing' | 'ready';
    retry: () => void;
}> {
    const library = useWorkflowDefinitionLibrary({ enabled: enabled && workflow !== null,
        ...(accountLifetime === undefined ? {} : { accountLifetime }) });
    const source = library.pluginWorkflows.find((entry) => entry.workflow === workflow) ?? null;
    React.useEffect(() => {
        if (enabled && workflow !== null && source === null && library.status === 'loaded'
            && library.hasMore && !library.loadingMore && !library.loadMoreFailed) library.loadMore();
    }, [enabled, workflow, source, library.status, library.hasMore, library.loadingMore, library.loadMoreFailed, library.loadMore]);
    return { source, status: !enabled || workflow === null ? 'idle' : source !== null ? 'ready'
        : library.status === 'failed' || library.loadMoreFailed ? 'failed'
            : library.status !== 'loaded' || library.hasMore ? 'loading' : 'missing',
        retry: library.loadMoreFailed ? library.loadMore : library.retry };
}

// ---- Run windows ------------------------------------------------------------------------------

type RunReadStatus = ReadStatus & Readonly<{ knownAt: number | null }>;
const INITIAL_RUN_STATUS: RunReadStatus = Object.freeze({ ...INITIAL_STATUS, knownAt: null });
type RunWindowStatuses = Readonly<Partial<Record<WorkflowRunListWindowStoreId, RunReadStatus>>>;
const EMPTY_RUN_STATUSES: RunWindowStatuses = Object.freeze({});
const runWindowStatusCell = createCell<RunWindowStatuses>(EMPTY_RUN_STATUSES);
type RunProjection = 'membership' | undefined;
type RunWindowRead = { promise: Promise<void>; refreshRequested: boolean; change?: WorkflowRunListInvalidation; projection: RunProjection; controller: AbortController };
type RunWindowReader = { lifetime: ActiveServerAccountScopeLifetime; fullReaders: number; membershipReaders: number; completeReaders: number;
    read?: RunWindowRead; unsubscribe?: () => void };
const runWindowReaders = new Map<WorkflowRunListWindowStoreId, RunWindowReader>();

function runWindowReader(windowId: WorkflowRunListWindowId, lifetime: ActiveServerAccountScopeLifetime): RunWindowReader {
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const existing = runWindowReaders.get(storeId);
    if (existing?.lifetime === lifetime) return existing;
    const reader = { lifetime, fullReaders: 0, membershipReaders: 0, completeReaders: 0 };
    runWindowReaders.set(storeId, reader);
    return reader;
}

function demandedRunProjection(windowId: WorkflowRunListWindowId, reader: RunWindowReader): RunProjection {
    return windowId === 'attention' && reader.fullReaders === 0 && reader.membershipReaders > 0 ? 'membership' : undefined;
}

function finishRunWindowRead(windowId: WorkflowRunListWindowId, lifetime: ServerAccountScopeLifetime, promise: Promise<void>, isCurrent: () => boolean): void {
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const reader = runWindowReaders.get(storeId);
    const read = reader?.read;
    if (!reader || read?.promise !== promise) return;
    delete reader.read;
    // A wake observed after this request began can describe a newer membership.
    // Restate it once after either the leading read or its continuation settles.
    if ((read.refreshRequested || (read.projection === 'membership' && reader.fullReaders > 0))
        && isCurrent() && reader.lifetime.isCurrent()
        && reader.fullReaders + reader.membershipReaders > 0) void refreshRunWindow(windowId, false, lifetime,
            read.projection === 'membership' && reader.fullReaders > 0 ? undefined : read.change);
    else if (reader.completeReaders > 0 && isCurrent() && reader.lifetime.isCurrent()
        && readRunWindowStatus(storeId).status === 'loaded' && !readRunWindowStatus(storeId).loadMoreFailed
        && getStorage().getState().workflowRunListWindows[storeId]?.nextCursor) void loadMoreRunWindow(windowId, lifetime);
    else if (reader.fullReaders + reader.membershipReaders === 0) runWindowReaders.delete(storeId);
}

function setRunWindowStatus(windowId: WorkflowRunListWindowStoreId, next: RunReadStatus): void {
    runWindowStatusCell.set({ ...runWindowStatusCell.get(), [windowId]: next });
}

function readRunWindowStatus(windowId: WorkflowRunListWindowStoreId): RunReadStatus {
    return runWindowStatusCell.get()[windowId] ?? INITIAL_RUN_STATUS;
}

type RunWindowPage = Omit<WorkflowRunListPage, 'nextCursor'> & Readonly<{
    automationRuns: readonly AutomationDefinitionRun[];
    nextCursor: string | null;
}>;

/** One page at the window owner, shared by initial reads and demand-driven continuation. */
export async function readRunWindowPage(windowId: WorkflowRunListWindowId, cursor?: string, projection?: 'membership', readMode?: 'complete', signal?: AbortSignal, accountLifetime?: ServerAccountScopeLifetime): Promise<RunWindowPage> {
    if (windowId === 'automationAttention') {
        const page = await listAutomationDefinitionRuns({ attention: 'required', cursor, signal });
        return { runs: [], automationRuns: page.runs, metadataByRunId: {}, nextCursor: page.nextCursor };
    }
    // Full rows open accepted snapshots. Request at most one window-height of
    // the smallest list rows; this is a presentation preference, not a corpus
    // or byte cap. The same owner follows opaque cursors on actual page demand.
    // A complete relation uses the server's existing response-byte budget;
    // membership-only badges keep their existing public projection/frontier.
    const limit = projection === undefined && readMode !== 'complete'
        ? Math.max(1, Math.ceil(Dimensions.get('window').height / HAPPIER_COLLECTION_ROW_METRICS.height.compact)) : undefined;
    const page = await listWorkflowRuns({ filter: buildWorkflowRunListFilter(windowId), cursor, projection, limit, signal, accountLifetime });
    return { ...page, automationRuns: [], nextCursor: page.nextCursor ?? null };
}

/** Restate a window through its loaded ordering frontier, retaining rows until the read succeeds. */
export function refreshRunWindow(windowId: WorkflowRunListWindowId, invalidate = false, accountLifetime?: ServerAccountScopeLifetime | null, change?: WorkflowRunListInvalidation): Promise<void> {
    // No selection means the producer requested a coarse reset (for example reconnect).
    if (!change?.runIds && !change?.sourceArtifactIds) change = undefined;
    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
    if (lifetime === null) return Promise.resolve();
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    const reader = runWindowReader(windowId, lifetime);
    const controller = new AbortController();
    const projection = demandedRunProjection(windowId, reader);
    const inFlight = reader.read;
    if (inFlight && !inFlight.controller.signal.aborted) {
        if (invalidate) {
            // Keep exact changes exact while sharing the existing in-flight read.
            // A coarse reset supersedes accumulated row selections.
            if (!inFlight.refreshRequested) inFlight.change = change;
            else if (!inFlight.change || !change) inFlight.change = undefined;
            else inFlight.change = { summaryCurrent: inFlight.change.summaryCurrent && change.summaryCurrent,
                runIds: [...new Set([...(inFlight.change.runIds ?? []), ...(change.runIds ?? [])])],
                ...((inFlight.change.sourceArtifactIds || change.sourceArtifactIds) ? {
                    sourceArtifactIds: [...new Set([...(inFlight.change.sourceArtifactIds ?? []), ...(change.sourceArtifactIds ?? [])])],
                } : {}) };
            inFlight.refreshRequested = true;
        }
        return inFlight.promise;
    }
    const retirement = lifetime.onRetire(() => controller.abort());
    const previous = readRunWindowStatus(storeId);
    const ownedBefore = previous.scopeKey === scopeKey && previous.status !== 'loading';
    const previousStore = getStorage().getState();
    const previousWindow = ownedBefore ? previousStore.workflowRunListWindows[storeId] : undefined;
    const promoting = previousWindow?.projection === 'membership' && projection === undefined;
    const previousTailId = previousWindow?.runIds.at(-1);
    const previousTail = previousTailId === undefined ? undefined : previousStore.workflowRunsById[workflowRunStoreKey(previousTailId, lifetime.scope)];
    const loadedBoundary = previousWindow?.frontier ?? (previousTail ? workflowRunListFrontier(previousTail) : undefined);
    if (!ownedBefore || promoting || previous.knownAt === null) setRunWindowStatus(storeId, { ...INITIAL_RUN_STATUS, scopeKey,
        knownAt: ownedBefore ? previous.knownAt : null });
    else if (previous.loadingMore || previous.loadMoreFailed) setRunWindowStatus(storeId, { ...previous, loadingMore: false, loadMoreFailed: false });
    const readRunWindow = async (): Promise<void> => {
        let continuing = false;
        try {
            if (windowId !== 'automationAttention' && previousWindow && !promoting && (change?.runIds || change?.sourceArtifactIds)) {
                const membershipChanged = await refreshWorkflowRunWindowChanges(windowId, change, lifetime, controller.signal, projection);
                if (!lifetime.isCurrent() || controller.signal.aborted) return;
                if (!membershipChanged) {
                    setRunWindowStatus(storeId, { ...readRunWindowStatus(storeId), status: 'loaded', failure: null, knownAt: Date.now() });
                    return;
                }
            }
            let page = await readRunWindowPage(windowId, undefined, projection, reader.completeReaders > 0 ? 'complete' : undefined, controller.signal, lifetime);
            if (!lifetime.isCurrent() || controller.signal.aborted) return;
            // Restate everything the person already paged to: a page-one-only
            // refresh can skip a burst of new rows or retain an older filtered-out row.
            // Traverse to the existing immutable ordering frontier, not an invented cap.
            if (loadedBoundary !== undefined || reader.completeReaders > 0) {
                const runs = [...page.runs];
                const automationRuns = [...page.automationRuns];
                const metadataByRunId = { ...page.metadataByRunId };
                const supportsAnotherRoundByRunId = { ...page.supportsAnotherRoundByRunId };
                const callerAccessByRunId = { ...page.callerAccessByRunId };
                while (page.nextCursor !== null) {
                    const lastSummary = page.runs.at(-1);
                    const lastAutomation = page.automationRuns.at(-1);
                    const last = lastSummary ? workflowRunRowFromSummary(lastSummary)
                        : lastAutomation ? workflowRunRowFromAutomationRun(lastAutomation) : undefined;
                    if (reader.completeReaders === 0 && (loadedBoundary === undefined
                        || last && (last.id === loadedBoundary.id || isBeyondWorkflowRunListSpan(last, loadedBoundary)))) break;
                    continuing = reader.completeReaders > 0;
                    if (reader.completeReaders > 0 && !readRunWindowStatus(storeId).loadingMore) {
                        setRunWindowStatus(storeId, { ...readRunWindowStatus(storeId), loadingMore: true });
                    }
                    page = await readRunWindowPage(windowId, page.nextCursor, projection, reader.completeReaders > 0 ? 'complete' : undefined, controller.signal, lifetime);
                    if (!lifetime.isCurrent() || controller.signal.aborted) return;
                    runs.push(...page.runs);
                    automationRuns.push(...page.automationRuns);
                    Object.assign(metadataByRunId, page.metadataByRunId);
                    Object.assign(supportsAnotherRoundByRunId, page.supportsAnotherRoundByRunId);
                    Object.assign(callerAccessByRunId, page.callerAccessByRunId);
                }
                page = { runs, automationRuns, metadataByRunId, supportsAnotherRoundByRunId, callerAccessByRunId,
                    ...(projection === undefined ? {} : { projection }), nextCursor: page.nextCursor };
            }
            const store = getStorage().getState();
            store.applyWorkflowRunListPage({
                windowId: storeId,
                scope: lifetime.scope,
                runs: page.runs,
                projection: page.projection,
                automationRuns: page.automationRuns,
                metadataByRunId: page.metadataByRunId,
                supportsAnotherRoundByRunId: page.supportsAnotherRoundByRunId,
                callerAccessByRunId: page.callerAccessByRunId,
                nextCursor: page.nextCursor ?? null,
                mode: 'replace',
            });
            setRunWindowStatus(storeId, { scopeKey, status: 'loaded', failure: null, loadingMore: false, loadMoreFailed: false, knownAt: Date.now() });
        } catch (error) {
            if (!lifetime.isCurrent() || controller.signal.aborted) return;
            setRunWindowStatus(storeId, {
                ...readRunWindowStatus(storeId),
                scopeKey,
                status: 'failed',
                loadingMore: false,
                loadMoreFailed: continuing,
                failure: resolveWorkflowProblemPresentation(error),
            });
        } finally {
            retirement.dispose();
            finishRunWindowRead(windowId, lifetime, promise, () => lifetime.isCurrent());
        }
    };
    const promise = readRunWindow();
    reader.read = { promise, refreshRequested: false, projection, controller };
    return promise;
}

export async function loadMoreRunWindow(windowId: WorkflowRunListWindowId, accountLifetime?: ServerAccountScopeLifetime | null): Promise<void> {
    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
    if (lifetime === null) return;
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    const reader = runWindowReader(windowId, lifetime);
    const controller = new AbortController();
    if (reader.read) return;
    const projection = demandedRunProjection(windowId, reader);
    const status = readRunWindowStatus(storeId);
    const window = getStorage().getState().workflowRunListWindows[storeId];
    if (window?.projection !== projection) { await refreshRunWindow(windowId, false, lifetime); return; }
    const cursor = window?.nextCursor ?? null;
    if (status.scopeKey !== scopeKey || status.status !== 'loaded' || cursor === null || status.loadingMore) return;
    const retirement = lifetime.onRetire(() => controller.abort());
    setRunWindowStatus(storeId, { ...status, loadingMore: true, loadMoreFailed: false });
    const readMore = async (): Promise<void> => {
        try {
            const page = await readRunWindowPage(windowId, cursor, projection, reader.completeReaders > 0 ? 'complete' : undefined, controller.signal, lifetime);
            if (!lifetime.isCurrent() || controller.signal.aborted) return;
            getStorage().getState().applyWorkflowRunListPage({
                windowId: storeId,
                scope: lifetime.scope,
                runs: page.runs,
                projection: page.projection,
                automationRuns: page.automationRuns,
                metadataByRunId: page.metadataByRunId,
                supportsAnotherRoundByRunId: page.supportsAnotherRoundByRunId,
                callerAccessByRunId: page.callerAccessByRunId,
                nextCursor: page.nextCursor ?? null,
                mode: 'append',
            });
            setRunWindowStatus(storeId, { ...readRunWindowStatus(storeId), loadingMore: false });
        } catch {
            if (lifetime.isCurrent() && !controller.signal.aborted) setRunWindowStatus(storeId, { ...readRunWindowStatus(storeId), loadingMore: false, loadMoreFailed: true });
        } finally {
            retirement.dispose();
            finishRunWindowRead(windowId, lifetime, promise, () => lifetime.isCurrent());
        }
    };
    const promise = readMore();
    reader.read = { promise, refreshRequested: false, projection, controller };
    await promise;
}

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);

export type WorkflowRunWindow = Readonly<{
    /** Captured by this window; row/result consumers keep its addressed Home. */
    accountLifetime: ServerAccountScopeLifetime | null;
    /** The exact Home serving this Account window; null until its first answer or after retirement. */
    serverId: string | null;
    status: WorkflowLibraryReadStatus;
    failure: WorkflowProblemPresentation | null;
    /** The window's rows, in its order, from the one Account-scoped Run store. */
    rows: ReturnType<typeof useWorkflowRunRows>;
    runIds: readonly string[];
    knownAt: number | null;
    hasMore: boolean;
    loadingMore: boolean;
    loadMoreFailed: boolean;
    retry: () => void;
    loadMore: () => void;
}>;

/**
 * One Run window (`all`, `active`, `attention`, `automationAttention`) while a surface shows it: its first
 * page on mount and on the Account's Run-change wake, and its rows from the shared Run store.
 * Complete readers demand the whole relation through that owner's response-byte continuations.
 * `enabled: false` holds no subscription and issues no read. `demanded: false`
 * retains observation of known rows/status while releasing network demand.
 */
export function useWorkflowRunWindow(windowId: WorkflowRunListWindowId, options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null; enabled?: boolean; demanded?: boolean; projection?: 'membership'; readMode?: 'complete' }> = {}): WorkflowRunWindow {
    const enabled = options.enabled !== false;
    const demanded = enabled && options.demanded !== false;
    const membershipOnly = windowId === 'attention' && options.projection === 'membership';
    const complete = options.readMode === 'complete';
    const active = useActiveServerAccountScopeLifetime();
    const addressed = useWorkflowAccountLifetime(options.accountLifetime);
    const lifetime = addressed === undefined ? active : addressed;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope === null ? null : serverAccountScopeKeySuffix(scope);
    const storeId = scope === null ? windowId : workflowRunListWindowStoreKey(windowId, scope);
    const readStatus = React.useCallback(() => enabled ? readRunWindowStatus(storeId) : INITIAL_RUN_STATUS, [enabled, storeId]);
    const status = React.useSyncExternalStore(
        enabled ? runWindowStatusCell.subscribe : subscribeInactiveDefinitions,
        readStatus,
        readStatus,
    );
    const owned = status.scopeKey === scopeKey && scopeKey !== null;
    const storedIds = getStorage()((state) => enabled ? state.workflowRunListWindows[storeId]?.runIds : undefined);
    const storedProjection = getStorage()((state) => enabled ? state.workflowRunListWindows[storeId]?.projection : undefined);
    const hasNextCursor = getStorage()((state) => enabled && (state.workflowRunListWindows[storeId]?.nextCursor ?? null) !== null);
    const runIds = enabled && owned && status.knownAt !== null ? storedIds ?? EMPTY_RUN_IDS : EMPTY_RUN_IDS;
    const rows = useWorkflowRunRows(membershipOnly || !demanded ? EMPTY_RUN_IDS : runIds, scope);
    const needsPromotion = !membershipOnly && storedProjection === 'membership';
    const knownAt = owned && !needsPromotion ? status.knownAt : null;

    React.useEffect(() => {
        if (!demanded || lifetime === null) return;
        const reader = runWindowReader(windowId, lifetime);
        if (membershipOnly) reader.membershipReaders += 1;
        else reader.fullReaders += 1;
        if (complete) reader.completeReaders += 1;
        void refreshRunWindow(windowId, false, lifetime);
        reader.unsubscribe ??= subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            ...(windowId !== 'automationAttention' && windowId.startsWith('exact:') ? { runIds: buildWorkflowRunListFilter(windowId).runIds } : {}),
            source: windowId === 'automationAttention' ? 'automation' : 'workflow',
            sourceArtifactIds: () => Object.values(getStorage().getState().workflowRunListWindows[storeId]?.sourceArtifactIdsByRunId ?? {}),
            isVisibleWindowLoaded: () => getStorage().getState().workflowRunListWindows[storeId]?.loaded === true
                || readRunWindowStatus(storeId).status === 'failed'
                || (runWindowReaders.get(storeId)?.lifetime === lifetime && runWindowReaders.get(storeId)?.read !== undefined),
            invalidate: change => { void refreshRunWindow(windowId, true, lifetime, change); },
        });
        return () => {
            if (membershipOnly) reader.membershipReaders -= 1;
            else reader.fullReaders -= 1;
            if (complete) reader.completeReaders -= 1;
            if (reader.fullReaders + reader.membershipReaders === 0) {
                reader.unsubscribe?.();
                delete reader.unsubscribe;
                reader.read?.controller.abort();
                if (!reader.read && runWindowReaders.get(storeId) === reader) runWindowReaders.delete(storeId);
            }
        };
    }, [complete, demanded, lifetime, membershipOnly, storeId, windowId]);

    const retry = React.useCallback(() => {
        if (lifetime === null) return;
        runWindowReaders.get(storeId)?.read?.controller.abort();
        void refreshRunWindow(windowId, false, lifetime);
    }, [lifetime, storeId, windowId]);
    const loadMore = React.useCallback(() => { void loadMoreRunWindow(windowId, lifetime); }, [lifetime, windowId]);
    return React.useMemo(() => ({
        accountLifetime: lifetime,
        serverId: enabled && owned && status.knownAt !== null ? scope?.serverId ?? null : null,
        status: !enabled ? 'loaded' : scopeKey === null ? 'failed' : owned
            ? needsPromotion && status.status === 'loaded' ? 'loading' : status.status : 'loading',
        failure: owned ? status.failure : null,
        rows,
        runIds,
        knownAt,
        hasMore: owned && hasNextCursor,
        loadingMore: owned && status.loadingMore,
        loadMoreFailed: owned && status.loadMoreFailed,
        retry,
        loadMore,
    }), [enabled, hasNextCursor, knownAt, lifetime, loadMore, needsPromotion, owned, retry, rows, runIds, scope?.serverId, scopeKey, status]);
}

/** Test seam: forget module read state between cases (the Run store is reset by its own owner). */
export function resetWorkflowLibraryReadsForTests(): void {
    activeDefinitionLibrary.reset();
    addressedDefinitionLibraries = new WeakMap();
    runWindowStatusCell.set({});
    for (const reader of runWindowReaders.values()) { reader.read?.controller.abort(); reader.unsubscribe?.(); }
    runWindowReaders.clear();
}

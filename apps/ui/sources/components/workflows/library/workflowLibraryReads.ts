import * as React from 'react';

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
    type WorkflowRunListWindowId,
} from '@/sync/store/domains/workflowRuns';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { listWorkflowDefinitions } from '@/sync/domains/workflows/workflowDefinitionActions';
import {
    buildWorkflowRunListFilter,
    listWorkflowRuns,
    type WorkflowRunListPage,
} from '@/sync/domains/workflows/workflowRunListActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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

const definitionsCell = createCell<DefinitionsState>(INITIAL_DEFINITIONS);
let definitionsInFlight: { lifetime: ActiveServerAccountScopeLifetime; promise: Promise<void>; kind: 'refresh' | 'more'; refreshRequested: boolean; deletionInvalidated: boolean } | null = null;
let definitionReaderCount = 0;
let unsubscribeDefinitionChange: (() => void) | null = null;
let deletionRetirement: Readonly<{ dispose(): void }> | null = null;

/** The loaded Workflow domain retains acknowledgements, even before its first library demand. */
function ensureDefinitionChangeObserver(): void {
    if (unsubscribeDefinitionChange === null) {
        unsubscribeDefinitionChange = subscribeHomeAccountChange((event) => {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (lifetime === null || !areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
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
ensureDefinitionChangeObserver();

/** The rail, page and pickers share one demanded read and one Account wake observer. */
function subscribeDefinitions(listener: () => void): () => void {
    const unsubscribe = definitionsCell.subscribe(listener);
    definitionReaderCount += 1;
    ensureDefinitionChangeObserver();
    return () => {
        unsubscribe();
        definitionReaderCount -= 1;
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
    const lifetime = captureActiveServerAccountScopeLifetime();
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
            let page = await listWorkflowDefinitions({});
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
                page = await listWorkflowDefinitions({ cursor: page.nextCursor });
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
    const lifetime = captureActiveServerAccountScopeLifetime();
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
            const page = await listWorkflowDefinitions({ cursor });
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
    const current = definitionsCell.get();
    if (current.deletedDefinitionId !== definitionId) return;
    definitionsCell.set({ ...current, deletedDefinitionId: null });
    deletionRetirement?.dispose();
    deletionRetirement = null;
}

const retryDefinitions = () => { void refreshDefinitions(); };
const requestMoreDefinitions = () => { void loadMoreDefinitions(); };
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
export function useWorkflowDefinitionLibrary(options?: Readonly<{ enabled?: boolean }>): WorkflowDefinitionLibrary {
    const enabled = options?.enabled ?? true;
    const lifetime = useActiveServerAccountScopeLifetime();
    const scopeKey = lifetime === null ? null : serverAccountScopeKeySuffix(lifetime.scope);
    const state = React.useSyncExternalStore(
        enabled ? subscribeDefinitions : subscribeInactiveDefinitions,
        enabled ? definitionsCell.get : readInactiveDefinitions,
        enabled ? definitionsCell.get : readInactiveDefinitions,
    );
    React.useEffect(() => { if (enabled && lifetime) void refreshDefinitions(); }, [enabled, lifetime]);
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
        retry: retryDefinitions,
        loadMore: requestMoreDefinitions,
    };
}

/** Resolve one plugin source through the same scoped pages as the library and pickers. */
export function useWorkflowPluginSource(workflow: string | null, enabled = true): Readonly<{
    source: WorkflowPluginSourceV1 | null;
    status: 'idle' | 'loading' | 'failed' | 'missing' | 'ready';
    retry: () => void;
}> {
    const library = useWorkflowDefinitionLibrary({ enabled: enabled && workflow !== null });
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
type RunWindowStatuses = Readonly<Partial<Record<WorkflowRunListWindowId, RunReadStatus>>>;
const EMPTY_RUN_STATUSES: RunWindowStatuses = Object.freeze({});
const runWindowStatusCell = createCell<RunWindowStatuses>(EMPTY_RUN_STATUSES);
type RunWindowRead = { lifetime: ActiveServerAccountScopeLifetime; promise: Promise<void>; refreshRequested: boolean };
const runWindowInFlight = new Map<WorkflowRunListWindowId, RunWindowRead>();

function finishRunWindowRead(windowId: WorkflowRunListWindowId, promise: Promise<void>, isCurrent: () => boolean): void {
    const read = runWindowInFlight.get(windowId);
    if (read?.promise !== promise) return;
    runWindowInFlight.delete(windowId);
    // A wake observed after this request began can describe a newer membership.
    // Restate it once after either the leading read or its continuation settles.
    if (read.refreshRequested && isCurrent()) void refreshRunWindow(windowId);
}

function setRunWindowStatus(windowId: WorkflowRunListWindowId, next: RunReadStatus): void {
    runWindowStatusCell.set({ ...runWindowStatusCell.get(), [windowId]: next });
}

function readRunWindowStatus(windowId: WorkflowRunListWindowId): RunReadStatus {
    return runWindowStatusCell.get()[windowId] ?? INITIAL_RUN_STATUS;
}

type RunWindowPage = Omit<WorkflowRunListPage, 'nextCursor'> & Readonly<{
    automationRuns: readonly AutomationDefinitionRun[];
    nextCursor: string | null;
}>;

async function readRunWindowPage(windowId: WorkflowRunListWindowId, cursor?: string): Promise<RunWindowPage> {
    if (windowId === 'automationAttention') {
        const page = await listAutomationDefinitionRuns({ attention: 'required', cursor });
        return { runs: [], automationRuns: page.runs, metadataByRunId: {}, nextCursor: page.nextCursor };
    }
    const page = await listWorkflowRuns({ filter: buildWorkflowRunListFilter(windowId), cursor });
    return { ...page, automationRuns: [], nextCursor: page.nextCursor ?? null };
}

/** Read a window's first page; a window this Account already traversed is restated, not replaced. */
function refreshRunWindow(windowId: WorkflowRunListWindowId, invalidate = false): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return Promise.resolve();
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    const inFlight = runWindowInFlight.get(windowId);
    if (inFlight?.lifetime === lifetime) {
        if (invalidate) inFlight.refreshRequested = true;
        return inFlight.promise;
    }
    const previous = readRunWindowStatus(windowId);
    const ownedBefore = previous.scopeKey === scopeKey && previous.status !== 'loading';
    const previousStore = getStorage().getState();
    const previousWindow = ownedBefore ? previousStore.workflowRunListWindows[windowId] : undefined;
    const previousTailId = previousWindow?.runIds.at(-1);
    const attentionBoundary = (windowId === 'attention' || windowId === 'automationAttention') && previousTailId !== undefined
        ? previousStore.workflowRunsById[previousTailId]
        : undefined;
    if (!ownedBefore) setRunWindowStatus(windowId, { ...INITIAL_RUN_STATUS, scopeKey });
    else if (previous.loadingMore || previous.loadMoreFailed) setRunWindowStatus(windowId, { ...previous, loadingMore: false, loadMoreFailed: false });
    const readRunWindow = async (): Promise<void> => {
        try {
            let page = await readRunWindowPage(windowId);
            if (!lifetime.isCurrent()) return;
            // Filtered attention must restate everything the person already paged to:
            // page-one-only refresh would retain a cleared failure on an older page.
            // Traverse to the existing immutable ordering frontier, not an invented cap.
            if (attentionBoundary !== undefined) {
                const runs = [...page.runs];
                const automationRuns = [...page.automationRuns];
                const metadataByRunId = { ...page.metadataByRunId };
                while (page.nextCursor !== null) {
                    const lastSummary = page.runs.at(-1);
                    const lastAutomation = page.automationRuns.at(-1);
                    const last = lastSummary ? workflowRunRowFromSummary(lastSummary)
                        : lastAutomation ? workflowRunRowFromAutomationRun(lastAutomation) : undefined;
                    if (last && (last.id === attentionBoundary.id || isBeyondWorkflowRunListSpan(last, attentionBoundary))) break;
                    page = await readRunWindowPage(windowId, page.nextCursor);
                    if (!lifetime.isCurrent()) return;
                    runs.push(...page.runs);
                    automationRuns.push(...page.automationRuns);
                    Object.assign(metadataByRunId, page.metadataByRunId);
                }
                page = { runs, automationRuns, metadataByRunId, nextCursor: page.nextCursor };
            }
            const store = getStorage().getState();
            store.applyWorkflowRunListPage({
                windowId,
                runs: page.runs,
                automationRuns: page.automationRuns,
                metadataByRunId: page.metadataByRunId,
                nextCursor: page.nextCursor ?? null,
                mode: attentionBoundary !== undefined ? 'replace'
                    : ownedBefore && store.workflowRunListWindows[windowId]?.loaded === true ? 'refresh' : 'replace',
            });
            setRunWindowStatus(windowId, { scopeKey, status: 'loaded', failure: null, loadingMore: false, loadMoreFailed: false, knownAt: Date.now() });
        } catch (error) {
            if (!lifetime.isCurrent()) return;
            setRunWindowStatus(windowId, {
                ...readRunWindowStatus(windowId),
                scopeKey,
                status: 'failed',
                failure: resolveWorkflowProblemPresentation(error),
            });
        } finally {
            finishRunWindowRead(windowId, promise, () => lifetime.isCurrent());
        }
    };
    const promise = readRunWindow();
    runWindowInFlight.set(windowId, { lifetime, promise, refreshRequested: false });
    return promise;
}

async function loadMoreRunWindow(windowId: WorkflowRunListWindowId): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    const pending = runWindowInFlight.get(windowId);
    if (pending?.lifetime === lifetime) return;
    if (pending) {
        await refreshRunWindow(windowId);
        return;
    }
    const status = readRunWindowStatus(windowId);
    const cursor = getStorage().getState().workflowRunListWindows[windowId]?.nextCursor ?? null;
    if (status.scopeKey !== scopeKey || status.status !== 'loaded' || cursor === null || status.loadingMore) return;
    setRunWindowStatus(windowId, { ...status, loadingMore: true, loadMoreFailed: false });
    const readMore = async (): Promise<void> => {
        try {
            const page = await readRunWindowPage(windowId, cursor);
            if (!lifetime.isCurrent()) return;
            getStorage().getState().applyWorkflowRunListPage({
                windowId,
                runs: page.runs,
                automationRuns: page.automationRuns,
                metadataByRunId: page.metadataByRunId,
                nextCursor: page.nextCursor ?? null,
                mode: 'append',
            });
            setRunWindowStatus(windowId, { ...readRunWindowStatus(windowId), loadingMore: false });
        } catch {
            if (lifetime.isCurrent()) setRunWindowStatus(windowId, { ...readRunWindowStatus(windowId), loadingMore: false, loadMoreFailed: true });
        } finally {
            finishRunWindowRead(windowId, promise, () => lifetime.isCurrent());
        }
    };
    const promise = readMore();
    runWindowInFlight.set(windowId, { lifetime, promise, refreshRequested: false });
    await promise;
}

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);

export type WorkflowRunWindow = Readonly<{
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
 * `enabled: false` holds no subscription and issues no read.
 */
export function useWorkflowRunWindow(windowId: WorkflowRunListWindowId, options: Readonly<{ enabled?: boolean }> = {}): WorkflowRunWindow {
    const enabled = options.enabled !== false;
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope === null ? null : serverAccountScopeKeySuffix(scope);
    const readStatus = React.useCallback(() => enabled ? readRunWindowStatus(windowId) : INITIAL_RUN_STATUS, [enabled, windowId]);
    const status = React.useSyncExternalStore(
        enabled ? runWindowStatusCell.subscribe : subscribeInactiveDefinitions,
        readStatus,
        readStatus,
    );
    const owned = status.scopeKey === scopeKey && scopeKey !== null;
    const storedIds = getStorage()((state) => enabled ? state.workflowRunListWindows[windowId]?.runIds : undefined);
    const hasNextCursor = getStorage()((state) => enabled && (state.workflowRunListWindows[windowId]?.nextCursor ?? null) !== null);
    const runIds = enabled && owned && status.knownAt !== null ? storedIds ?? EMPTY_RUN_IDS : EMPTY_RUN_IDS;
    const rows = useWorkflowRunRows(runIds);

    React.useEffect(() => {
        if (!enabled || lifetime === null) return;
        void refreshRunWindow(windowId);
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            source: windowId === 'automationAttention' ? 'automation' : 'workflow',
            isVisibleWindowLoaded: () => getStorage().getState().workflowRunListWindows[windowId]?.loaded === true
                || readRunWindowStatus(windowId).status === 'failed'
                || runWindowInFlight.get(windowId)?.lifetime === lifetime,
            invalidate: () => { void refreshRunWindow(windowId, true); },
        });
    }, [enabled, lifetime, windowId]);

    const retry = React.useCallback(() => { void refreshRunWindow(windowId, true); }, [windowId]);
    const loadMore = React.useCallback(() => { void loadMoreRunWindow(windowId); }, [windowId]);
    return {
        serverId: enabled && owned && status.knownAt !== null ? scope?.serverId ?? null : null,
        status: !enabled ? 'loaded' : scopeKey === null ? 'failed' : owned ? status.status : 'loading',
        failure: owned ? status.failure : null,
        rows,
        runIds,
        knownAt: owned ? status.knownAt : null,
        hasMore: owned && hasNextCursor,
        loadingMore: owned && status.loadingMore,
        loadMoreFailed: owned && status.loadMoreFailed,
        retry,
        loadMore,
    };
}

/** Test seam: forget module read state between cases (the Run store is reset by its own owner). */
export function resetWorkflowLibraryReadsForTests(): void {
    unsubscribeDefinitionChange?.();
    unsubscribeDefinitionChange = null;
    deletionRetirement?.dispose();
    deletionRetirement = null;
    definitionsCell.set(INITIAL_DEFINITIONS);
    definitionsInFlight = null;
    runWindowStatusCell.set({});
    runWindowInFlight.clear();
    ensureDefinitionChangeObserver();
}

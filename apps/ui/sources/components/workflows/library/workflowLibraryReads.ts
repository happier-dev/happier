import * as React from 'react';

import type { WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';
import { sameStrictJsonValue } from '@happier-dev/protocol';

import {
    resolveWorkflowProblemPresentation,
    type WorkflowProblemPresentation,
} from '@/components/workflows/presentation/workflowProblemPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope, useWorkflowRunRows } from '@/sync/domains/state/storage';
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

function useActiveScopeKey(): string | null {
    const scope = useActiveServerAccountScope();
    return scope === null ? null : serverAccountScopeKeySuffix(scope);
}

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
}>;

const INITIAL_DEFINITIONS: DefinitionsState = Object.freeze({
    ...INITIAL_STATUS,
    definitions: Object.freeze([]) as readonly WorkflowLibraryDefinition[],
    pluginWorkflows: Object.freeze([]) as readonly WorkflowPluginSourceV1[],
    nextCursor: null,
    loadedPages: 0,
});

const definitionsCell = createCell<DefinitionsState>(INITIAL_DEFINITIONS);
let definitionsInFlight: Readonly<{ scopeKey: string | null; promise: Promise<void>; kind: 'refresh' | 'more' }> | null = null;

function retainEqualLibraryRows<T>(previous: readonly T[], incoming: readonly T[], key: (row: T) => string): readonly T[] {
    const previousById = new Map(previous.map((row) => [key(row), row]));
    const rows = incoming.map((row) => {
        const stored = previousById.get(key(row));
        return stored !== undefined && sameStrictJsonValue(stored, row) ? stored : row;
    });
    return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}

/** Refresh the already-demanded pages atomically; mounts in the same Account share one read. */
function refreshDefinitions(): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return Promise.resolve();
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    if (definitionsInFlight?.scopeKey === scopeKey) return definitionsInFlight.promise;
    const previous = definitionsCell.get();
    const demandedPages = previous.scopeKey === scopeKey ? Math.max(1, previous.loadedPages) : 1;
    // Another Account's rows are never shown while this one loads.
    if (previous.scopeKey !== scopeKey) definitionsCell.set({ ...INITIAL_DEFINITIONS, scopeKey });
    else if (previous.status === 'failed') definitionsCell.set({ ...previous, status: 'loading' });
    const readDefinitions = async (): Promise<void> => {
        try {
            let page = await listWorkflowDefinitions({});
            const definitions = new Map(page.definitions.map((row) => [row.definitionId, row]));
            const plugins = new Map((page.pluginWorkflows ?? []).map((row) => [row.workflow, row]));
            let loadedPages = 1;
            while (lifetime.isCurrent() && page.nextCursor && loadedPages < demandedPages) {
                page = await listWorkflowDefinitions({ cursor: page.nextCursor });
                for (const row of page.definitions) definitions.set(row.definitionId, row);
                for (const row of page.pluginWorkflows ?? []) plugins.set(row.workflow, row);
                loadedPages += 1;
            }
            if (!lifetime.isCurrent()) return;
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
            };
            definitionsCell.set(sameStrictJsonValue(current, next) ? current : next);
        } catch (error) {
            if (!lifetime.isCurrent()) return;
            // A failed refresh keeps what is already loaded and says why.
            definitionsCell.set({
                ...definitionsCell.get(),
                scopeKey,
                status: 'failed',
                failure: resolveWorkflowProblemPresentation(error),
            });
        } finally {
            if (definitionsInFlight?.promise === promise) definitionsInFlight = null;
        }
    };
    const promise = readDefinitions();
    definitionsInFlight = { scopeKey, promise, kind: 'refresh' };
    return promise;
}

async function loadMoreDefinitions(): Promise<void> {
    const current = definitionsCell.get();
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null || current.nextCursor === null || current.loadingMore) return;
    const cursor = current.nextCursor;
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    if (current.scopeKey !== scopeKey) return;
    const pending = definitionsInFlight;
    if (pending?.scopeKey === scopeKey) {
        await pending.promise;
        if (pending.kind === 'refresh' && lifetime.isCurrent()) await loadMoreDefinitions();
        return;
    }
    definitionsCell.set({ ...current, loadingMore: true, loadMoreFailed: false });
    const readPage = async () => {
        try {
            const page = await listWorkflowDefinitions({ cursor });
            if (!lifetime.isCurrent()) return;
            const latest = definitionsCell.get();
            const seen = new Set(latest.definitions.map((entry) => entry.definitionId));
            const seenPlugins = new Set(latest.pluginWorkflows.map((entry) => entry.workflow));
            const addedPlugins = (page.pluginWorkflows ?? []).filter((entry) => {
                if (seenPlugins.has(entry.workflow)) return false;
                seenPlugins.add(entry.workflow);
                return true;
            });
            definitionsCell.set({
                ...latest,
                loadingMore: false,
                definitions: [...latest.definitions, ...page.definitions.filter((entry) => !seen.has(entry.definitionId))],
                pluginWorkflows: addedPlugins.length === 0 ? latest.pluginWorkflows : [...latest.pluginWorkflows, ...addedPlugins],
                nextCursor: page.nextCursor ?? null,
                loadedPages: latest.loadedPages + 1,
            });
        } catch {
            // The loaded rows and the cursor stay; Retry asks for exactly this page again.
            if (lifetime.isCurrent()) definitionsCell.set({ ...definitionsCell.get(), loadingMore: false, loadMoreFailed: true });
        } finally {
            if (definitionsInFlight?.promise === promise) definitionsInFlight = null;
        }
    };
    const promise = readPage();
    definitionsInFlight = { scopeKey, promise, kind: 'more' };
    await promise;
}

/** Drop a deleted definition from the loaded rows without re-reading the list. */
export function forgetWorkflowLibraryDefinition(definitionId: string): void {
    const current = definitionsCell.get();
    if (!current.definitions.some((entry) => entry.definitionId === definitionId)) return;
    definitionsCell.set({ ...current, definitions: current.definitions.filter((entry) => entry.definitionId !== definitionId) });
}

export type WorkflowDefinitionLibrary = Readonly<{
    status: WorkflowLibraryReadStatus;
    failure: WorkflowProblemPresentation | null;
    definitions: readonly WorkflowLibraryDefinition[];
    pluginWorkflows: readonly WorkflowPluginSourceV1[];
    hasMore: boolean;
    loadingMore: boolean;
    loadMoreFailed: boolean;
    retry: () => void;
    loadMore: () => void;
}>;

const retryDefinitions = () => { void refreshDefinitions(); };
const requestMoreDefinitions = () => { void loadMoreDefinitions(); };
const subscribeInactiveDefinitions = (_listener: () => void) => () => {};
const readInactiveDefinitions = () => INITIAL_DEFINITIONS;
const INACTIVE_DEFINITION_LIBRARY: WorkflowDefinitionLibrary = Object.freeze({
    status: 'loading', failure: null,
    definitions: INITIAL_DEFINITIONS.definitions, pluginWorkflows: INITIAL_DEFINITIONS.pluginWorkflows,
    hasMore: false, loadingMore: false, loadMoreFailed: false,
    retry: retryDefinitions, loadMore: requestMoreDefinitions,
});

/** The saved definitions, refreshed when a surface that shows them mounts or the Account changes. */
export function useWorkflowDefinitionLibrary(options?: Readonly<{ enabled?: boolean }>): WorkflowDefinitionLibrary {
    const enabled = options?.enabled ?? true;
    const scopeKey = useActiveScopeKey();
    const state = React.useSyncExternalStore(
        enabled ? definitionsCell.subscribe : subscribeInactiveDefinitions,
        enabled ? definitionsCell.get : readInactiveDefinitions,
        enabled ? definitionsCell.get : readInactiveDefinitions,
    );
    React.useEffect(() => { if (enabled) void refreshDefinitions(); }, [enabled, scopeKey]);
    if (!enabled) return INACTIVE_DEFINITION_LIBRARY;
    const owned = state.scopeKey === scopeKey;
    return {
        status: owned ? state.status : 'loading',
        failure: owned ? state.failure : null,
        definitions: owned ? state.definitions : INITIAL_DEFINITIONS.definitions,
        pluginWorkflows: owned ? state.pluginWorkflows : INITIAL_DEFINITIONS.pluginWorkflows,
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
type RunWindowRead = { scopeKey: string; promise: Promise<void>; refreshRequested: boolean };
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
    if (inFlight?.scopeKey === scopeKey) {
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
    runWindowInFlight.set(windowId, { scopeKey, promise, refreshRequested: false });
    return promise;
}

async function loadMoreRunWindow(windowId: WorkflowRunListWindowId): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
    if (runWindowInFlight.get(windowId)?.scopeKey === scopeKey) return;
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
    runWindowInFlight.set(windowId, { scopeKey, promise, refreshRequested: false });
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
    const scope = useActiveServerAccountScope();
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
        if (!enabled) return;
        void refreshRunWindow(windowId);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            source: windowId === 'automationAttention' ? 'automation' : 'workflow',
            isVisibleWindowLoaded: () => getStorage().getState().workflowRunListWindows[windowId]?.loaded === true
                || readRunWindowStatus(windowId).status === 'failed'
                || runWindowInFlight.get(windowId)?.scopeKey === scopeKey,
            invalidate: () => { void refreshRunWindow(windowId, true); },
        });
    }, [enabled, scopeKey, windowId]);

    const retry = React.useCallback(() => { void refreshRunWindow(windowId, true); }, [windowId]);
    const loadMore = React.useCallback(() => { void loadMoreRunWindow(windowId); }, [windowId]);
    return {
        serverId: enabled && owned && status.knownAt !== null ? scope?.serverId ?? null : null,
        status: owned ? status.status : 'loading',
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
    definitionsCell.set(INITIAL_DEFINITIONS);
    definitionsInFlight = null;
    runWindowStatusCell.set({});
    runWindowInFlight.clear();
}

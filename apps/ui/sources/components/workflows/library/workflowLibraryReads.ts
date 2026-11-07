import * as React from 'react';
import { Dimensions } from 'react-native';
import { workflowRunStoreKey, workflowRunListWindowStoreKey, type WorkflowRunListWindowStoreId } from '@/sync/store/domains/workflowRuns';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1, workflowDefinitionListCursorPhaseV1, type WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
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
import { assertWorkflowRunWindowScope, refreshWorkflowRunWindowChanges } from './workflowRunWindowChanges';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

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

function affectsWorkflowDefinitions(event: HomeAccountChangeEvent, lifetime: ServerAccountScopeLifetime): boolean {
    return areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
        && event.workflowDefinitionsAffect !== false;
}

/** A selected definition consumes the same producer-classified change as the header library. */
export function affectsSelectedWorkflowDefinition(event: HomeAccountChangeEvent, lifetime: ServerAccountScopeLifetime, definitionId: string): boolean {
    return affectsWorkflowDefinitions(event, lifetime)
        && (event.changedWorkflowDefinitionIds === undefined || event.changedWorkflowDefinitionIds.includes(definitionId));
}

function createDefinitionLibraryReader(captureLifetime: () => ServerAccountScopeLifetime | null, addressed = false, definitionIds?: readonly string[]) {
    const definitionsCell = createCell<DefinitionsState>(INITIAL_DEFINITIONS);
    let definitionsInFlight: { lifetime: ActiveServerAccountScopeLifetime; promise: Promise<void>; kind: 'refresh' | 'more'; refreshRequested: false | 'all' | Set<string>; deletionInvalidated: boolean; controller: AbortController } | null = null;
    let definitionReaderCount = 0;
    let unsubscribeDefinitionChange: (() => void) | null = null;
    let deletionRetirement: Readonly<{ dispose(): void }> | null = null;
    // What a closed library missed. The wake observer outlives its readers, so a reopen keeps the
    // last-good rows and reads only when this lifetime never completed a list, a coarse wake
    // arrived, or named rows (or Machine plugin sources) changed while nothing showed them.
    let followedLifetime: ServerAccountScopeLifetime | null = null;
    const closedChangedIds = new Set<string>();
    let closedPluginSources = false;

    /** The loaded Workflow domain retains acknowledgements, even before its first library demand. */
    function ensureDefinitionChangeObserver(): void {
        if (unsubscribeDefinitionChange === null) {
            unsubscribeDefinitionChange = subscribeHomeAccountChange((event) => {
                const lifetime = captureLifetime();
                if (lifetime === null || !areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
                // The Home producer classifies saved/source/access changes once;
                // unrelated content never queues an inventory recheck.
                const deletedDefinitionId = event.deletedArtifactIds?.find(id => definitionIds === undefined || definitionIds.includes(id));
                if (deletedDefinitionId !== undefined) {
                    if (definitionsInFlight?.lifetime === lifetime) definitionsInFlight.deletionInvalidated = true;
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
                // A deletion receipt supplies landing feedback. Its feed row,
                // rather than this local acknowledgement, owns query refresh.
                if (event.workflowDefinitionsAffect === false) {
                    // A Machine row can change only Machine-contributed sources, never a saved row.
                    if (event.workflowPluginSourcesAffect === true) {
                        if (definitionReaderCount > 0) refreshPluginSources();
                        else closedPluginSources = true;
                    }
                    return;
                }
                const changedIds = (event.workflowDefinitionAutomationIds === undefined ? undefined
                    : definitionIdsShowingAutomations(event.workflowDefinitionAutomationIds, scopeKeyOf(lifetime)))
                    ?? (definitionIds === undefined ? event.changedWorkflowDefinitionIds
                        : event.changedWorkflowDefinitionIds?.filter(id => definitionIds.includes(id)));
                if (changedIds?.length === 0) return;
                // The producer pairs exact Artifact ids. The list owner opens only
                // those records to decide membership; source/recovery facts stay broad.
                if (definitionsInFlight?.lifetime === lifetime) {
                    if (!changedIds) definitionsInFlight.refreshRequested = 'all';
                    else if (definitionsInFlight.refreshRequested !== 'all') {
                        const ids = definitionsInFlight.refreshRequested || new Set<string>();
                        for (const id of changedIds) ids.add(id);
                        definitionsInFlight.refreshRequested = ids;
                    }
                    // Ordinary wakes queue a recheck without withholding usable rows.
                    // Only an acknowledged deletion makes the pending result obsolete.
                    if (deletedDefinitionId !== undefined) definitionsInFlight.deletionInvalidated = true;
                }
                else if (definitionReaderCount > 0) void refreshDefinitions(changedIds);
                else if (changedIds) for (const id of changedIds) closedChangedIds.add(id);
                else followedLifetime = null;
            }, { reconnect: { readNotCurrent: () => {
                // A failed list or plugin continuation retries on reconnect; loaded rows follow the feed.
                const current = definitionsCell.get();
                return current.status !== 'loaded' || current.loadMoreFailed;
            } } });
        }
    }

    function scopeKeyOf(lifetime: ServerAccountScopeLifetime): string {
        return serverAccountScopeKeySuffix(lifetime.scope);
    }
    /**
     * The loaded rows that show these Automations. A row lists its triggers' Automation ids, so an
     * edited Automation re-reads only its row. An id no loaded row shows (a new trigger) may belong
     * to any definition: the list is read again.
     */
    function definitionIdsShowingAutomations(automationIds: readonly string[], scopeKey: string): readonly string[] | undefined {
        const current = definitionsCell.get();
        if (current.scopeKey !== scopeKey || current.status !== 'loaded') return undefined;
        const byAutomation = new Map<string, string[]>();
        for (const row of current.definitions) for (const trigger of row.triggers ?? []) {
            if (trigger.automationId === undefined) continue;
            const rows = byAutomation.get(trigger.automationId) ?? [];
            rows.push(row.definitionId);
            byAutomation.set(trigger.automationId, rows);
        }
        const ids = new Set<string>();
        for (const automationId of automationIds) {
            const rows = byAutomation.get(automationId);
            if (rows === undefined) return undefined;
            for (const id of rows) if (definitionIds === undefined || definitionIds.includes(id)) ids.add(id);
        }
        return [...ids];
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
            if (definitionReaderCount === 0) {
                // An abandoned read may have carried queued wakes: the next open reads the list.
                if (definitionsInFlight) followedLifetime = null;
                definitionsInFlight?.controller.abort();
                definitionsInFlight = null;
            }
            if (addressed && definitionReaderCount === 0) {
                followedLifetime = null;
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
        if (read.refreshRequested && isCurrent() && definitionReaderCount > 0) {
            void refreshDefinitions(read.refreshRequested === 'all' ? undefined : [...read.refreshRequested]);
        }
        else if (isCurrent() && definitionReaderCount > 0 && !definitionsCell.get().loadMoreFailed
            && workflowDefinitionListCursorPhaseV1(definitionsCell.get().nextCursor) === 'plugins-start') void loadMoreDefinitions();
    }

    /** Refresh demanded Account pages together, then discover plugins without gating saved rows. */
    function refreshDefinitions(changedArtifactIds?: readonly string[]): Promise<void> {
        if (definitionReaderCount === 0) return Promise.resolve();
        const lifetime = captureLifetime();
        if (lifetime === null) return Promise.resolve();
        const scopeKey = serverAccountScopeKeySuffix(lifetime.scope);
        // The same Home/Account can reactivate while its retired request is still pending.
        // Only demand captured in this exact lifetime may join or queue behind that read.
        if (definitionsInFlight?.lifetime === lifetime && !definitionsInFlight.controller.signal.aborted) return definitionsInFlight.promise;
        definitionsInFlight?.controller.abort();
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
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
                const exactIds = previous.scopeKey === scopeKey && previous.status === 'loaded'
                    ? changedArtifactIds ?? definitionIds : definitionIds;
                if (exactIds) {
                    const pages = await Promise.all(exactIds.map(definitionId => listWorkflowDefinitions({ definitionId,
                        signal: controller.signal, ...(addressed ? { accountLifetime: lifetime } : {}) })));
                    if (!isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                    const current = definitionsCell.get();
                    const changed = new Set(exactIds);
                    const incoming = pages.flatMap(page => page.definitions);
                    const definitions = retainKeyedRows(current.definitions,
                        [...incoming, ...current.definitions.filter(row => !changed.has(row.definitionId))], row => row.definitionId);
                    const next = { ...current, status: 'loaded' as const, failure: null, definitions,
                        loadedPages: Math.max(1, current.loadedPages) };
                    definitionsCell.set(sameStrictJsonValue(current, next) ? current : next);
                    return;
                }
                let page = await listWorkflowDefinitions({ signal: controller.signal, ...(addressed ? { accountLifetime: lifetime } : {}) });
                const definitions = new Map(page.definitions.map((row) => [row.definitionId, row]));
                const plugins = new Map((page.pluginWorkflows ?? []).map((row) => [row.workflow, row]));
                let loadedPages = 1;
                while (isCurrent() && definitionReaderCount > 0 && !definitionsInFlight?.deletionInvalidated && page.nextCursor && (loadedPages < demandedPages
                    || (!pluginContinuation && workflowDefinitionListCursorPhaseV1(page.nextCursor) === 'plugins-start'))) {
                    if (!pluginContinuation && workflowDefinitionListCursorPhaseV1(page.nextCursor) !== 'artifacts') {
                        // Account content and built-ins remain usable while the daemon is
                        // pending. Same-Account refresh keeps last-known plugin rows until
                        // their authoritative continuation replaces them.
                        pluginContinuation = { cursor: page.nextCursor, loadedPages };
                        const current = definitionsCell.get();
                        const savedRows = retainKeyedRows(current.definitions, [...definitions.values()], (row) => row.definitionId);
                        // Already-visible equal rows need no transient refresh notification.
                        if (!definitionsInFlight?.deletionInvalidated && (current.status !== 'loaded' || savedRows !== current.definitions)) definitionsCell.set({
                            ...current, scopeKey, status: 'loaded', failure: null, definitions: savedRows,
                            nextCursor: page.nextCursor, loadedPages, loadingMore: true, loadMoreFailed: false,
                        });
                    }
                    page = await listWorkflowDefinitions({ cursor: page.nextCursor, signal: controller.signal, ...(addressed ? { accountLifetime: lifetime } : {}) });
                    for (const row of page.definitions) definitions.set(row.definitionId, row);
                    for (const row of page.pluginWorkflows ?? []) plugins.set(row.workflow, row);
                    loadedPages += 1;
                }
                if (!isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                const current = definitionsCell.get();
                const next: DefinitionsState = {
                    scopeKey,
                    status: 'loaded',
                    failure: null,
                    loadingMore: false,
                    loadMoreFailed: false,
                    definitions: retainKeyedRows(current.definitions, [...definitions.values()], (row) => row.definitionId),
                    pluginWorkflows: retainKeyedRows(current.pluginWorkflows, [...plugins.values()], (row) => row.workflow),
                    nextCursor: page.nextCursor ?? null,
                    loadedPages,
                    deletedDefinitionId: current.deletedDefinitionId,
                };
                definitionsCell.set(sameStrictJsonValue(current, next) ? current : next);
                followedLifetime = lifetime;
            } catch (error) {
                if (!isCurrent() || definitionsInFlight?.deletionInvalidated) return;
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
                retirement.dispose();
                finishDefinitionRead(promise, isCurrent);
            }
        };
        const promise = readDefinitions();
        definitionsInFlight = { lifetime, promise, kind: 'refresh', refreshRequested: false, deletionInvalidated: false, controller };
        return promise;
    }

    /** A surface opens: last-good rows stay, and only what this lifetime has not followed is read. */
    function demandDefinitions(): void {
        const lifetime = captureLifetime();
        if (lifetime === null) return;
        const current = definitionsCell.get();
        if (followedLifetime !== lifetime || current.scopeKey !== scopeKeyOf(lifetime) || current.status !== 'loaded'
            || current.loadMoreFailed || (closedPluginSources && closedChangedIds.size > 0)) {
            closedChangedIds.clear(); closedPluginSources = false;
            void refreshDefinitions();
            return;
        }
        if (closedChangedIds.size > 0) {
            const ids = [...closedChangedIds];
            closedChangedIds.clear();
            void refreshDefinitions(ids);
        }
        if (closedPluginSources) { closedPluginSources = false; refreshPluginSources(); }
    }

    /**
     * Re-derive the plugin phase only, for as many plugin pages as are shown. A saved list still
     * paging its Account rows reads its plugin sources when it gets there; a running read already will.
     */
    function refreshPluginSources(): void {
        if (definitionReaderCount === 0 || definitionIds !== undefined || definitionsInFlight !== null) return;
        const lifetime = captureLifetime();
        const current = definitionsCell.get();
        if (lifetime === null || !lifetime.isCurrent() || current.status !== 'loaded' || current.loadingMore || current.loadMoreFailed
            || current.scopeKey !== serverAccountScopeKeySuffix(lifetime.scope)
            || (current.nextCursor !== null && workflowDefinitionListCursorPhaseV1(current.nextCursor) === 'artifacts')) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
        const readSources = async () => {
            try {
                const plugins = new Map<string, WorkflowPluginSourceV1>();
                let cursor: string | undefined = `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0`;
                let nextCursor: string | null = null;
                while (cursor !== undefined && isCurrent()) {
                    const page = await listWorkflowDefinitions({ cursor, signal: controller.signal, ...(addressed ? { accountLifetime: lifetime } : {}) });
                    for (const row of page.pluginWorkflows ?? []) plugins.set(row.workflow, row);
                    nextCursor = page.nextCursor ?? null;
                    cursor = page.nextCursor !== undefined && plugins.size < current.pluginWorkflows.length ? page.nextCursor : undefined;
                }
                if (!isCurrent() || definitionsInFlight?.deletionInvalidated) return;
                const latest = definitionsCell.get();
                const pluginWorkflows = retainKeyedRows(latest.pluginWorkflows, [...plugins.values()], (row) => row.workflow);
                if (pluginWorkflows !== latest.pluginWorkflows || nextCursor !== latest.nextCursor) {
                    definitionsCell.set({ ...latest, pluginWorkflows, nextCursor });
                }
            } catch {
                // As in a full refresh: shown sources stay and Retry continues the plugin phase.
                if (isCurrent() && !definitionsInFlight?.deletionInvalidated) definitionsCell.set({ ...definitionsCell.get(),
                    nextCursor: `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0`, loadMoreFailed: true });
            } finally {
                retirement.dispose();
                finishDefinitionRead(promise, isCurrent);
            }
        };
        const promise = readSources();
        definitionsInFlight = { lifetime, promise, kind: 'more', refreshRequested: false, deletionInvalidated: false, controller };
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
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
        const readPage = async () => {
            try {
                const page = await listWorkflowDefinitions({ cursor, signal: controller.signal, ...(addressed ? { accountLifetime: lifetime } : {}) });
                if (!isCurrent() || definitionsInFlight?.deletionInvalidated) return;
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
                        ? retainKeyedRows(latest.pluginWorkflows, addedPlugins, (row) => row.workflow)
                        : addedPlugins.length === 0 ? latest.pluginWorkflows : [...latest.pluginWorkflows, ...addedPlugins],
                    nextCursor: page.nextCursor ?? null,
                    loadedPages: latest.loadedPages + 1,
                });
            } catch {
                // The loaded rows and the cursor stay; Retry asks for exactly this page again.
                if (isCurrent() && !definitionsInFlight?.deletionInvalidated) definitionsCell.set({ ...definitionsCell.get(), loadingMore: false, loadMoreFailed: true });
            } finally {
                retirement.dispose();
                finishDefinitionRead(promise, isCurrent);
            }
        };
        const promise = readPage();
        definitionsInFlight = { lifetime, promise, kind: 'more', refreshRequested: false, deletionInvalidated: false, controller };
        await promise;
    }

    return {
        cell: definitionsCell, subscribe: subscribeDefinitions,
        demand: demandDefinitions,
        retry: () => { definitionsInFlight?.controller.abort(); void refreshDefinitions(); },
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
            definitionsInFlight?.controller.abort();
            definitionsCell.set(INITIAL_DEFINITIONS); definitionsInFlight = null;
            followedLifetime = null; closedChangedIds.clear(); closedPluginSources = false;
            ensureDefinitionChangeObserver();
        },
    };
}

const activeDefinitionLibrary = createDefinitionLibraryReader(captureActiveServerAccountScopeLifetime);
let addressedDefinitionLibraries = new WeakMap<ServerAccountScopeLifetime, Map<string, ReturnType<typeof createDefinitionLibraryReader>>>();
function definitionLibraryForLifetime(lifetime: ServerAccountScopeLifetime | null | undefined, definitionIds?: readonly string[]) {
    if (!lifetime || definitionIds?.length === 0) return activeDefinitionLibrary;
    if (definitionIds === undefined && areServerAccountScopesEqual(lifetime.scope, captureActiveServerAccountScopeLifetime()?.scope)) return activeDefinitionLibrary;
    let windows = addressedDefinitionLibraries.get(lifetime);
    if (!windows) { windows = new Map(); addressedDefinitionLibraries.set(lifetime, windows); }
    const key = definitionIds === undefined ? '' : JSON.stringify(definitionIds);
    let reader = windows.get(key);
    if (!reader) {
        reader = createDefinitionLibraryReader(() => lifetime.isCurrent() ? lifetime : null, true, definitionIds);
        windows.set(key, reader);
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

/** The saved definitions: last-good on reopen, read when this Account lifetime has not followed them. */
export function useWorkflowDefinitionLibrary(options?: Readonly<{
    enabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null; definitionIds?: readonly string[];
}>): WorkflowDefinitionLibrary {
    const addressedLifetime = useWorkflowAccountLifetime(options?.accountLifetime);
    const enabled = options?.enabled ?? true;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const definitionIds = React.useMemo(() => options?.definitionIds === undefined ? undefined
        : [...new Set(options.definitionIds)].sort(), [options?.definitionIds]);
    const reader = definitionLibraryForLifetime(definitionIds === undefined ? addressedLifetime : lifetime, definitionIds);
    const readable = enabled && (definitionIds === undefined ? addressedLifetime === undefined || lifetime?.isCurrent() === true
        : definitionIds.length > 0 && lifetime?.isCurrent() === true);
    const scopeKey = lifetime === null ? null : serverAccountScopeKeySuffix(lifetime.scope);
    const state = React.useSyncExternalStore(
        readable ? reader.subscribe : subscribeInactiveDefinitions,
        readable ? reader.cell.get : readInactiveDefinitions,
        readable ? reader.cell.get : readInactiveDefinitions,
    );
    React.useEffect(() => { if (readable && lifetime) reader.demand(); }, [readable, lifetime, reader]);
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

/** Reuse admitted library facts, or demand this exact source through the same Action owner. */
export function useWorkflowPluginSource(workflow: string | null, enabled = true, accountLifetime?: ServerAccountScopeLifetime | null): Readonly<{
    source: WorkflowPluginSourceV1 | null;
    status: 'idle' | 'loading' | 'failed' | 'missing' | 'ready';
    retry: () => void;
}> {
    accountLifetime = useWorkflowAccountLifetime(accountLifetime);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = accountLifetime === undefined ? activeLifetime : accountLifetime;
    const reader = definitionLibraryForLifetime(accountLifetime);
    const scopeKey = lifetime ? serverAccountScopeKeySuffix(lifetime.scope) : null;
    // Observe only the exact admitted hit, without demanding collection pages or
    // rerendering when unrelated saved rows/status change.
    const getKnown = React.useCallback(() => {
        if (!enabled || workflow === null || !lifetime?.isCurrent()) return null;
        const library = reader.cell.get();
        return library.scopeKey === scopeKey ? library.pluginWorkflows.find(entry => entry.workflow === workflow) ?? null : null;
    }, [enabled, workflow, lifetime, reader, scopeKey]);
    const known = React.useSyncExternalStore(enabled && workflow !== null ? reader.cell.subscribe : subscribeInactiveDefinitions, getKnown, getKnown);
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt(value => value + 1), []);
    const [read, setRead] = React.useState<Readonly<{
        workflow: string; lifetime: ServerAccountScopeLifetime; attempt: number;
        source: WorkflowPluginSourceV1 | null; status: 'ready' | 'missing' | 'failed';
    }> | null>(null);
    React.useEffect(() => {
        if (!enabled || workflow === null || !lifetime?.isCurrent()) return;
        const retirement = lifetime.onRetire(retry);
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!affectsWorkflowDefinitions(event, lifetime)) return;
            retry();
        }, { reconnect: 'refresh' });
        return () => { unsubscribe(); retirement.dispose(); };
    }, [enabled, workflow, lifetime, retry]);
    React.useEffect(() => {
        if (!enabled || workflow === null || !lifetime?.isCurrent() || (known !== null && attempt === 0)) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => { controller.abort(); setRead(null); });
        void listWorkflowDefinitions({ workflow, signal: controller.signal,
            ...(accountLifetime === undefined ? {} : { accountLifetime }) }).then(result => {
            if (controller.signal.aborted || !lifetime.isCurrent()) return;
            const source = result.pluginWorkflows?.[0] ?? null;
            setRead({ workflow, lifetime, attempt, source, status: source === null ? 'missing' : 'ready' });
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setRead({ workflow, lifetime, attempt, source: null, status: 'failed' });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [enabled, workflow, lifetime, accountLifetime, known, attempt]);
    if (!enabled || workflow === null) return { source: null, status: 'idle', retry };
    if (!lifetime?.isCurrent()) return { source: null, status: 'failed', retry };
    const current = read?.workflow === workflow && read.lifetime === lifetime && read.attempt === attempt ? read : null;
    return { source: current?.source ?? (current === null ? known : null),
        status: current?.status ?? (known === null ? 'loading' : 'ready'), retry };
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
    read?: RunWindowRead; unsubscribe?: () => void;
    /** What the next open must read: nothing, the exact Runs/sources that changed while closed, or the window. */
    stale: false | 'all' | WorkflowRunListInvalidation };
const runWindowReaders = new Map<WorkflowRunListWindowStoreId, RunWindowReader>();

function runWindowReader(windowId: WorkflowRunListWindowId, lifetime: ActiveServerAccountScopeLifetime): RunWindowReader {
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const existing = runWindowReaders.get(storeId);
    if (existing?.lifetime === lifetime) return existing;
    const reader: RunWindowReader = { lifetime, fullReaders: 0, membershipReaders: 0, completeReaders: 0, stale: 'all' };
    runWindowReaders.set(storeId, reader);
    return reader;
}

/**
 * The fixed windows (`all`, `active`, `attention`, `automationAttention`) keep observing their
 * Account's Run wakes for the reader's lifetime, so a reopen serves the shared Run store without a
 * read. Exact Run-set windows are per-detail demand and stop observing with their last reader.
 */
function observesWhileClosed(windowId: WorkflowRunListWindowId): boolean {
    return !windowId.startsWith('exact:') && !windowId.startsWith('session-origin:') && !windowId.startsWith('session-destination:');
}

/** Two pending changes share one read; a coarse change (no named Runs or sources) supersedes them. */
function mergeRunListChanges(previous: WorkflowRunListInvalidation | undefined, next: WorkflowRunListInvalidation | undefined): WorkflowRunListInvalidation | undefined {
    if (!previous || !next) return undefined;
    return { summaryCurrent: previous.summaryCurrent && next.summaryCurrent,
        runIds: [...new Set([...(previous.runIds ?? []), ...(next.runIds ?? [])])],
        ...((previous.sourceArtifactIds || next.sourceArtifactIds) ? {
            sourceArtifactIds: [...new Set([...(previous.sourceArtifactIds ?? []), ...(next.sourceArtifactIds ?? [])])],
        } : {}) };
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
    else if (reader.fullReaders + reader.membershipReaders === 0 && !reader.unsubscribe) runWindowReaders.delete(storeId);
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
    assertWorkflowRunWindowScope(windowId, page.runs);
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
            inFlight.change = inFlight.refreshRequested ? mergeRunListChanges(inFlight.change, change) : change;
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
                const membership = await refreshWorkflowRunWindowChanges(windowId, change, lifetime, controller.signal, projection);
                if (!lifetime.isCurrent() || controller.signal.aborted) return;
                if (membership === 'current') return;
                if (membership === 'unchanged') {
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
 * page on first demand in an Account lifetime and on the Account's Run-change wake, and its rows from
 * the shared Run store. A reopen keeps those rows and reads only the Runs that changed while closed.
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
    const subscribeLifetime = React.useCallback((listener: () => void) => {
        const retirement = lifetime?.onRetire(listener);
        return () => retirement?.dispose();
    }, [lifetime]);
    const readLifetimeCurrent = React.useCallback(() => lifetime?.isCurrent() === true, [lifetime]);
    const current = React.useSyncExternalStore(subscribeLifetime, readLifetimeCurrent, readLifetimeCurrent);
    const scope = current ? lifetime?.scope ?? null : null;
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
        if (!demanded || !current || lifetime === null) return;
        const reader = runWindowReader(windowId, lifetime);
        if (membershipOnly) reader.membershipReaders += 1;
        else reader.fullReaders += 1;
        if (complete) reader.completeReaders += 1;
        // Reopen from the shared Run store; read only what was missed while closed.
        const stale = reader.stale;
        reader.stale = false;
        const known = readRunWindowStatus(storeId);
        const stored = getStorage().getState().workflowRunListWindows[storeId];
        if (stale !== false || reader.read || known.status !== 'loaded' || known.loadMoreFailed
            || known.scopeKey !== serverAccountScopeKeySuffix(lifetime.scope) || !stored
            || (stored.projection !== undefined && stored.projection !== demandedRunProjection(windowId, reader))
            || (complete && stored.nextCursor)) {
            void refreshRunWindow(windowId, false, lifetime, stale === false || stale === 'all' ? undefined : stale);
        }
        reader.unsubscribe ??= subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            ...(windowId !== 'automationAttention' && windowId.startsWith('exact:') ? { runIds: buildWorkflowRunListFilter(windowId).runIds } : {}),
            source: windowId === 'automationAttention' ? 'automation' : 'workflow',
            discoverSourceArtifacts: windowId !== 'automationAttention',
            sourceArtifactIds: () => Object.values(getStorage().getState().workflowRunListWindows[storeId]?.sourceArtifactIdsByRunId ?? {}),
            isVisibleWindowLoaded: () => getStorage().getState().workflowRunListWindows[storeId]?.loaded === true
                || readRunWindowStatus(storeId).status === 'failed'
                || (runWindowReaders.get(storeId)?.lifetime === lifetime && runWindowReaders.get(storeId)?.read !== undefined),
            invalidate: change => {
                if (reader.fullReaders + reader.membershipReaders > 0) { void refreshRunWindow(windowId, true, lifetime, change); return; }
                reader.stale = reader.stale === false ? change : reader.stale === 'all' ? 'all' : mergeRunListChanges(reader.stale, change) ?? 'all';
            },
        });
        return () => {
            if (membershipOnly) reader.membershipReaders -= 1;
            else reader.fullReaders -= 1;
            if (complete) reader.completeReaders -= 1;
            if (reader.fullReaders + reader.membershipReaders === 0) {
                // An abandoned read may have carried queued wakes: the next open reads the window.
                if (reader.read) reader.stale = 'all';
                reader.read?.controller.abort();
                if (observesWhileClosed(windowId)) return;
                reader.unsubscribe?.();
                delete reader.unsubscribe;
                reader.stale = 'all';
                if (!reader.read && runWindowReaders.get(storeId) === reader) runWindowReaders.delete(storeId);
            }
        };
    }, [complete, current, demanded, lifetime, membershipOnly, storeId, windowId]);

    const retry = React.useCallback(() => {
        if (!current || lifetime === null) return;
        runWindowReaders.get(storeId)?.read?.controller.abort();
        void refreshRunWindow(windowId, false, lifetime);
    }, [current, lifetime, storeId, windowId]);
    const loadMore = React.useCallback(() => {
        if (current) void loadMoreRunWindow(windowId, lifetime);
    }, [current, lifetime, windowId]);
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

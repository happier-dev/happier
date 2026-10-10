import type { CompactAppDestination, DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { hrefForDestinationRef, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationHistory, recordWorkspaceNavigation, stepWorkspaceNavigation, workspaceNavigationRestorationActions, type WorkspaceNavigationEntry } from './workspaceNavigationHistory';
import { createWorkspaceEmptyTab, type WorkspaceAction, type WorkspaceState, type WorkspaceTab } from './workspaceState';
import { isWorkspaceSingletonDestination } from './workspaceDestinationPolicy';
import { createWorkspaceDestinationSplit } from './workspaceSplit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type WorkspaceOpenOptions = Readonly<{
    mode?: 'preview' | 'newTab' | 'splitLeft' | 'splitRight' | 'splitUp' | 'splitDown';
    tabId?: string;
    groupId?: string;
    beforeTabId?: string | null;
    reuseExisting?: boolean;
    replace?: boolean;
    availableSizePx?: number;
    minimumFirstSizePx?: number;
    minimumSecondSizePx?: number;
}>;

export type WorkspaceOpenDestination = Readonly<{ tabId: string; groupId: string }>;

/** The URL transport does not decide what a tab is or which destination is focused. */
export type WorkspaceUrlTransport = Readonly<{
    commit: (href: string, entry: WorkspaceNavigationEntry, replace: boolean, position: number) => void;
    adoptCurrent?: (entry: WorkspaceNavigationEntry, position: number) => void;
    traverse?: (direction: -1 | 1) => void;
    /** The browser retains entry positions across reloads; native transports use the local history. */
    canTraverse?: (direction: -1 | 1) => boolean | undefined;
}>;

export function sameDestinationRef(a: DestinationRef, b: DestinationRef): boolean {
    return a.kind === b.kind && Object.keys(a.params).length === Object.keys(b.params).length
        && Object.entries(a.params).every(([key, value]) => b.params[key] === value);
}

export function createWorkspaceNavigationAdapter(input: Readonly<{
    getState: () => WorkspaceState;
    getCatalog: () => readonly CompactAppDestination[];
    getScope?: () => ServerAccountScope | null;
    dispatch: (action: WorkspaceAction) => void;
    transport: WorkspaceUrlTransport;
    createId: () => string;
    onChange: () => void;
    resolveOpenHref?: (href: string) => string | null;
}>) {
    let history = createWorkspaceNavigationHistory();
    const resolveOpenTarget = (href: string): DestinationRef | null => {
        const admitted = input.resolveOpenHref ? input.resolveOpenHref(href) : href;
        return admitted ? resolveDestinationRefFromHref(input.getCatalog(), admitted) : null;
    };
    const findOpenDestination = (target: DestinationRef, state = input.getState()): WorkspaceOpenDestination | null => {
        const catalog = input.getCatalog();
        const singleton = isWorkspaceSingletonDestination(catalog, target);
        const scope = input.getScope?.();
        const sessionIdentity = (ref: DestinationRef) => {
            const serverId = ref.params.serverId ?? scope?.serverId;
            // Missing qualifiers denote the current persisted workspace realm,
            // never an Account on an explicitly different Home.
            return { id: ref.params.id, serverId, accountId: ref.params.accountId
                ?? (serverId === scope?.serverId ? scope?.accountId : undefined) };
        };
        const identity = target.kind === 'session' ? sessionIdentity(target) : null;
        const tab = Object.values(state.tabs).find(tab => {
            if (singleton) return tab.target.kind === target.kind;
            const href = hrefForDestinationRef(catalog, tab.target);
            const normalized = href ? resolveDestinationRefFromHref(catalog, href) : null;
            if (!normalized || normalized.kind !== target.kind) return false;
            // SessionAddress owns resource identity; pane URL state and anchors belong
            // to the retained view, and must not turn Go to it into a duplicate tab.
            if (!identity) return sameDestinationRef(normalized, target);
            const candidate = sessionIdentity(normalized);
            return candidate.id === identity.id && candidate.serverId === identity.serverId
                && candidate.accountId === identity.accountId;
        });
        const group = tab ? Object.values(state.groups).find(group => group.tabIds.includes(tab.id)) : null;
        return tab && group ? { tabId: tab.id, groupId: group.id } : null;
    };
    const focusedEntry = (): WorkspaceNavigationEntry => {
        const state = input.getState();
        const group = state.groups[state.focusedGroupId];
        const tab = state.tabs[group.activeTabId];
        return { tabId: tab.id, groupId: group.id, target: tab.target };
    };
    const visit = (replace = false, projectUrl = true, forceProjection = false) => {
        const entry = focusedEntry();
        const next = replace && history.index >= 0
            ? { entries: history.entries.map((item, index) => index === history.index ? entry : item), index: history.index }
            : recordWorkspaceNavigation(history, entry);
        const unchanged = next === history;
        if (unchanged && !(projectUrl && forceProjection)) return;
        history = next;
        if (projectUrl) {
            const href = hrefForDestinationRef(input.getCatalog(), entry.target);
            if (href) input.transport.commit(href, entry, replace || unchanged, history.index);
        } else input.transport.adoptCurrent?.(entry, history.index);
        if (!unchanged) input.onChange();
    };
    const singletonActions = (state: WorkspaceState, target: DestinationRef): readonly WorkspaceAction[] | null => {
        // The catalog owns admission: subpaths never change an app page's mount identity.
        if (!isWorkspaceSingletonDestination(input.getCatalog(), target)) return null;
        const existing = findOpenDestination(target, state);
        return existing ? [
            { type: 'setTarget', tabId: existing.tabId, target },
            { type: 'activateTab', groupId: existing.groupId, tabId: existing.tabId },
        ] : null;
    };
    const restore = (entry: WorkspaceNavigationEntry) => {
        const state = input.getState();
        for (const action of singletonActions(state, entry.target) ?? workspaceNavigationRestorationActions(state, entry)) input.dispatch(action);
        return focusedEntry();
    };
    return {
        resolveOpenTarget,
        get history() { return history; },
        get canGoBack() { return input.transport.canTraverse?.(-1) ?? history.index > 0; },
        get canGoForward() { return input.transport.canTraverse?.(1) ?? history.index < history.entries.length - 1; },
        findOpenHref(href: string): WorkspaceOpenDestination | null {
            const target = resolveOpenTarget(href);
            return target ? findOpenDestination(target) : null;
        },
        initialize(href: string) {
            this.openHref(href, { replace: true });
        },
        openHref(href: string, options: WorkspaceOpenOptions = {}, projectUrl = true): boolean {
            const target = resolveOpenTarget(href);
            if (!target) return false;
            const state = input.getState();
            if (options.tabId && !state.tabs[options.tabId]) return false;
            if (options.groupId && !state.groups[options.groupId]) return false;
            if (options.tabId && options.groupId && !state.groups[options.groupId].tabIds.includes(options.tabId)) return false;
            const openingGroupId = options.groupId ?? state.focusedGroupId;
            const mode = options.mode ?? 'preview';
            const admittedSingleton = singletonActions(state, target);
            const reusable = options.reuseExisting && !options.tabId ? findOpenDestination(target) : null;
            if (reusable && !admittedSingleton) {
                if (mode !== 'preview') input.dispatch({ type: 'promoteTab', tabId: reusable.tabId });
                input.dispatch({ type: 'activateTab', groupId: reusable.groupId, tabId: reusable.tabId });
            } else if (admittedSingleton) {
                if (admittedSingleton.length === 0) return false;
                for (const action of admittedSingleton) input.dispatch(action);
                if (mode === 'newTab') input.dispatch({ type: 'promoteTab', tabId: focusedEntry().tabId });
            } else if (options.tabId && state.tabs[options.tabId]) {
                const group = Object.values(state.groups).find((item) => item.tabIds.includes(options.tabId!));
                if (!group) return false;
                input.dispatch({ type: 'setTarget', tabId: options.tabId, target });
                if (mode === 'newTab') input.dispatch({ type: 'promoteTab', tabId: options.tabId });
                input.dispatch({ type: 'activateTab', groupId: group.id, tabId: options.tabId });
            } else {
                const existing = mode === 'preview' || mode === 'newTab'
                    ? Object.values(state.tabs).find((tab) => sameDestinationRef(tab.target, target)
                        && (mode === 'preview' || tab.preview)
                        && (!options.groupId || state.groups[options.groupId].tabIds.includes(tab.id))) : undefined;
                if (existing) {
                    const group = Object.values(state.groups).find((item) => item.tabIds.includes(existing.id));
                    if (!group) return false;
                    if (mode === 'newTab') input.dispatch({ type: 'promoteTab', tabId: existing.id });
                    input.dispatch({ type: 'activateTab', groupId: group.id, tabId: existing.id });
                } else {
                    const direction = mode === 'splitLeft' ? 'left' : mode === 'splitRight' ? 'right'
                        : mode === 'splitUp' ? 'up' : mode === 'splitDown' ? 'down' : null;
                    if (direction && (options.availableSizePx === undefined || options.minimumFirstSizePx === undefined)) return false;
                    const tab: WorkspaceTab = { id: input.createId(), target, pinned: false, preview: mode === 'preview' };
                    const openAction: WorkspaceAction = { type: 'openTab', groupId: openingGroupId, tab, beforeTabId: options.beforeTabId };
                    if (direction) {
                        const action = createWorkspaceDestinationSplit(state, {
                            groupId: openingGroupId, tab, direction, createId: input.createId,
                            availableSizePx: options.availableSizePx!, minimumExistingSizePx: options.minimumFirstSizePx!,
                        });
                        if (!action) return false;
                        input.dispatch(action);
                    } else input.dispatch(openAction);
                }
            }
            visit(options.replace, projectUrl, true);
            return true;
        },
        activateTab(groupId: string, tabId: string) {
            input.dispatch({ type: 'activateTab', groupId, tabId });
            visit(false, true, true);
        },
        dispatch(action: WorkspaceAction) {
            if (action.type === 'reopenTab') { this.reopenTab(action.tabId); return; }
            input.dispatch(action);
            visit();
        },
        reopenTab(tabId?: string): boolean {
            const state = input.getState();
            const entry = tabId ? state.recentlyClosed.find(item => item.tab.id === tabId) : state.recentlyClosed[0];
            if (!entry) return false;
            const singleton = singletonActions(state, entry.tab.target)?.find(action => action.type === 'activateTab');
            input.dispatch({ type: 'reopenTab', tabId: entry.tab.id,
                ...(singleton?.type === 'activateTab' ? { reuseTabId: singleton.tabId } : {}),
            });
            visit();
            return true;
        },
        closeTab(groupId: string, tabId: string) {
            input.dispatch({ type: 'closeTab', groupId, tabId, newTab: createWorkspaceEmptyTab(input.createId()) });
            visit();
        },
        closeTabs(groupId: string, tabIds: readonly string[]) {
            const state = input.getState();
            const group = state.groups[groupId];
            if (!group) return;
            for (const tabId of new Set(tabIds)) {
                if (group.tabIds.includes(tabId) && !state.tabs[tabId]?.pinned) {
                    input.dispatch({ type: 'closeTab', groupId, tabId, newTab: createWorkspaceEmptyTab(input.createId()) });
                }
            }
            visit();
        },
        setParams(tabId: string, values: Readonly<Record<string, unknown>>) {
            const state = input.getState();
            const tab = state.tabs[tabId];
            if (!tab) return;
            const params = { ...tab.target.params };
            for (const [key, value] of Object.entries(values)) {
                if (value === undefined || value === null) delete params[key];
                else if (typeof value === 'string') params[key] = value;
                else if (typeof value === 'number' || typeof value === 'boolean') params[key] = String(value);
            }
            const target = { ...tab.target, params };
            if (sameDestinationRef(target, tab.target)) return;
            input.dispatch({ type: 'setTarget', tabId, target });
            if (focusedEntry().tabId === tabId) visit(true);
        },
        acceptUrl(href: string, entry?: WorkspaceNavigationEntry, position?: number) {
            if (entry) {
                const restoredEntry = restore(entry);
                const index = position !== undefined && history.entries[position]
                    ? position : history.index;
                history = index >= 0 ? {
                    entries: history.entries.map((item, at) => at === index ? restoredEntry : item), index,
                } : recordWorkspaceNavigation(history, restoredEntry);
                input.transport.adoptCurrent?.(restoredEntry, history.index);
                input.onChange();
                return true;
            }
            const target = resolveDestinationRefFromHref(input.getCatalog(), href);
            if (!target) return false;
            if (sameDestinationRef(focusedEntry().target, target)) {
                input.transport.adoptCurrent?.(focusedEntry(), history.index);
                return true;
            }
            return this.openHref(href, {}, false);
        },
        step(direction: -1 | 1) {
            if (direction === -1 ? !this.canGoBack : !this.canGoForward) return;
            if (input.transport.traverse) {
                input.transport.traverse(direction);
                return;
            }
            const next = stepWorkspaceNavigation(history, direction);
            if (!next.entry) return;
            history = next.history;
            const restoredEntry = restore(next.entry);
            history = { ...history, entries: history.entries.map((item, index) => index === history.index ? restoredEntry : item) };
            const href = hrefForDestinationRef(input.getCatalog(), restoredEntry.target);
            if (href) input.transport.commit(href, restoredEntry, true, history.index);
            input.onChange();
        },
    };
}

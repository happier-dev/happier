import type { CompactAppDestination, DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { hrefForDestinationRef, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationHistory, recordWorkspaceNavigation, stepWorkspaceNavigation, workspaceNavigationRestorationActions, type WorkspaceNavigationEntry } from './workspaceNavigationHistory';
import { createWorkspaceEmptyTab, type WorkspaceAction, type WorkspaceState, type WorkspaceTab } from './workspaceState';
import { isWorkspaceSingletonDestination, resolveWorkspaceDestinationScope, shouldRetainWorkspaceDestinationPreview, workspaceDestinationNavigationIdentity } from './workspaceDestinationPolicy';
import { createWorkspaceDestinationSplit } from './workspaceSplit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { matchWorkspaceDestinationRoute } from './workspaceRoutes';
import { parseSessionPaneUrlState, serializeSessionPaneUrlState, SESSION_PANE_URL_PARAM_KEYS } from '@/components/sessions/panes/url/sessionPaneUrlState';

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
    /** Release a source pane only after navigation guards and destination admission succeed. */
    onOpened?: () => void;
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

/** The Projects list's open: the Project at its overview with only its checkout selection. */
const PROJECT_DEFAULT_OPEN_PARAMS = new Set(['workspaceRefId', 'serverId', 'accountId', 'pageId', 'activeRootPath', 'worktreeId']);
function isProjectDefaultOpen(target: DestinationRef): boolean {
    return (target.params.pageId ?? 'overview') === 'overview'
        && Object.keys(target.params).every(key => PROJECT_DEFAULT_OPEN_PARAMS.has(key));
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
    /** Capture source intent before a new destination replaces it; commit only after successful navigation. */
    prepareOpen?: (source: WorkspaceNavigationEntry, destination: WorkspaceNavigationEntry,
        options: WorkspaceOpenOptions) => ((opened: WorkspaceNavigationEntry) => void) | undefined;
}>) {
    let history = createWorkspaceNavigationHistory();
    const resolveOpenTarget = (href: string): DestinationRef | null => {
        const admitted = input.resolveOpenHref ? input.resolveOpenHref(href) : href;
        const catalog = input.getCatalog();
        const target = admitted ? resolveDestinationRefFromHref(catalog, admitted) : null;
        return target ? resolveWorkspaceDestinationScope(target, catalog, input.getScope?.()) : null;
    };
    const isSessionTerminal = (ref: DestinationRef) => {
        if (ref.params.workspacePathname
            && matchWorkspaceDestinationRoute(ref.params.workspacePathname)?.routeKey === 'session/[id]/terminal') return true;
        if (ref.kind !== 'session') return false;
        const pane = parseSessionPaneUrlState(ref.params);
        return pane?.rightTabId === 'terminal'
            || (!pane?.details && !pane?.rightTabId && pane?.bottomTabId === 'terminal');
    };
    const sessionIdentity = (ref: DestinationRef) => {
        if (ref.kind !== 'session' && ref.kind !== 'sessionDetails' && !isSessionTerminal(ref)) return null;
        const scope = input.getScope?.();
        const serverId = ref.params.serverId ?? scope?.serverId;
        // Missing qualifiers denote the current persisted workspace realm,
        // never an Account on an explicitly different Home.
        return { id: ref.params.id, serverId, accountId: ref.params.accountId
            ?? (areServerProfileIdentifiersEquivalent(serverId, scope?.serverId) ? scope?.accountId : undefined) };
    };
    const sameSessionIdentity = (a: DestinationRef, b: DestinationRef) => {
        const identity = sessionIdentity(a);
        const candidate = sessionIdentity(b);
        return identity !== null && candidate !== null && candidate.id === identity.id
            && (candidate.serverId === identity.serverId || areServerProfileIdentifiersEquivalent(candidate.serverId, identity.serverId))
            && candidate.accountId === identity.accountId;
    };
    // A Project is one resource per Home: opening it again goes to its tab, like a Session.
    const projectIdentity = (ref: DestinationRef) => ref.kind === 'project' && ref.params.workspaceRefId
        ? { id: ref.params.workspaceRefId, serverId: ref.params.serverId ?? input.getScope?.()?.serverId } : null;
    const sameProjectIdentity = (a: DestinationRef, b: DestinationRef) => {
        const identity = projectIdentity(a);
        const candidate = projectIdentity(b);
        return identity !== null && candidate !== null && candidate.id === identity.id
            && (candidate.serverId === identity.serverId || areServerProfileIdentifiersEquivalent(candidate.serverId, identity.serverId));
    };
    const adoptSessionTarget = (retained: DestinationRef, target: DestinationRef): DestinationRef => {
        const params: Record<string, string> = { ...retained.params, ...target.params,
            ...(retained.params.serverId ? { serverId: retained.params.serverId } : {}),
        };
        const incomingPane = parseSessionPaneUrlState(target.params);
        if (incomingPane?.details) {
            // An addressed resource replaces its previous anchor/view/comparison,
            // while unaddressed side and bottom panes stay in the retained view.
            for (const key of SESSION_PANE_URL_PARAM_KEYS) delete params[key];
            Object.assign(params, serializeSessionPaneUrlState({
                ...parseSessionPaneUrlState(retained.params), ...incomingPane,
            }));
        }
        // A responsive return to the Session root must not keep projecting the
        // phone child route from the previous view's params.
        if (!target.params.workspacePathname) delete params.workspacePathname;
        return { ...target, params };
    };
    const findOpenDestination = (target: DestinationRef, state = input.getState(), groupId?: string, tabId?: string): WorkspaceOpenDestination | null => {
        const catalog = input.getCatalog();
        const scope = input.getScope?.();
        const singleton = isWorkspaceSingletonDestination(catalog, target);
        const navigationIdentity = workspaceDestinationNavigationIdentity(target, catalog, scope);
        const identity = sessionIdentity(target);
        const tab = Object.values(state.tabs).find(tab => {
            if (tabId && tab.id !== tabId) return false;
            if (groupId && !state.groups[groupId]?.tabIds.includes(tab.id)) return false;
            if (singleton) return tab.target.kind === target.kind && isWorkspaceSingletonDestination(catalog, tab.target);
            if (navigationIdentity !== null) return workspaceDestinationNavigationIdentity(tab.target, catalog, scope) === navigationIdentity;
            const href = hrefForDestinationRef(catalog, tab.target);
            const normalized = href ? resolveDestinationRefFromHref(catalog, href) : null;
            if (!normalized) return false;
            // Go to a Session retains its pane state. An addressed Details page is
            // its own destination: sharing the Session address cannot select Chat
            // or a different file when an Action asks to reuse an existing tab.
            if (identity && target.kind !== 'sessionDetails') {
                return sameSessionIdentity(normalized, target);
            }
            if (projectIdentity(target)) return sameProjectIdentity(normalized, target);
            return sameDestinationRef(normalized, target);
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
            const target = resolveOpenTarget(href);
            const reusable = target && sessionIdentity(target) ? findOpenDestination(target) : null;
            if (target && reusable) {
                // Cold admission addresses the Session, not a new pane. Keep its
                // saved view state and Home qualifier while applying explicit URL state.
                const retained = input.getState().tabs[reusable.tabId].target;
                const adopted = adoptSessionTarget(retained, target);
                if (!sameDestinationRef(retained, adopted)) input.dispatch({ type: 'setTarget', tabId: reusable.tabId, target: adopted });
                input.dispatch({ type: 'activateTab', groupId: reusable.groupId, tabId: reusable.tabId });
                visit(true, false, true);
                return;
            }
            // The navigator is already mounting this URL; adopt it rather than
            // dispatching a replacement before its route is registered.
            this.openHref(href, { replace: true }, false);
        },
        openHref(href: string, options: WorkspaceOpenOptions = {}, projectUrl = true): boolean {
            const target = resolveOpenTarget(href);
            if (!target) return false;
            const state = input.getState();
            if (options.tabId && !state.tabs[options.tabId]) return false;
            if (options.groupId && !state.groups[options.groupId]) return false;
            if (options.tabId && options.groupId && !state.groups[options.groupId].tabIds.includes(options.tabId)) return false;
            const openingGroupId = options.groupId ?? (options.tabId
                ? Object.values(state.groups).find(group => group.tabIds.includes(options.tabId!))?.id : undefined) ?? state.focusedGroupId;
            const mode = options.mode ?? 'preview';
            const sourceTab = state.tabs[options.tabId ?? state.groups[openingGroupId].activeTabId];
            const sourceEntry: WorkspaceNavigationEntry | undefined = sourceTab
                ? { tabId: sourceTab.id, groupId: openingGroupId, target: sourceTab.target } : undefined;
            let finishOpen: ((opened: WorkspaceNavigationEntry) => void) | undefined = undefined;
            const keepSourcePreview = !options.replace && sourceTab?.preview
                && shouldRetainWorkspaceDestinationPreview(sourceTab.target, target, input.getCatalog(), input.getScope?.());
            const retainSourcePreview = () => {
                if (keepSourcePreview) input.dispatch({ type: 'promoteTab', tabId: sourceTab.id });
            };
            const admittedSingleton = singletonActions(state, target);
            const resourcePreview = mode === 'preview' && options.reuseExisting !== false
                && workspaceDestinationNavigationIdentity(target, input.getCatalog()) !== null;
            // A bare Session address is Go to it, including Expo URL adoption.
            // Terminal and unaddressed Details presentations keep the Session's pane scope;
            // resource-addressed Details and explicit new-tab/split intents remain independent.
            const sessionPreview = mode === 'preview' && target.kind === 'session' && options.reuseExisting !== false
                && Object.keys(target.params).every(key => key === 'id' || key === 'serverId' || key === 'accountId');
            const presentationPreview = mode === 'preview' && options.reuseExisting !== false
                && (isSessionTerminal(target) || (target.kind === 'session' && target.params.mobileSurface === 'tabs'));
            // A mounted destination router supplies its SOURCE tabId. A bare
            // Session address still focuses the retained resource across panes.
            const reusable = (options.reuseExisting || sessionPreview || presentationPreview || resourcePreview) && (!options.tabId || sessionPreview || presentationPreview || resourcePreview)
                ? (presentationPreview ? findOpenDestination(target, state, options.groupId,
                    options.tabId ?? state.groups[openingGroupId].activeTabId) : null)
                    ?? findOpenDestination(target, state, options.reuseExisting ? undefined : options.groupId) : null;
            if (reusable && !admittedSingleton) {
                retainSourcePreview();
                const retained = state.tabs[reusable.tabId].target;
                // Reuse retains pane state, but an explicitly selected Session
                // address must qualify a legacy tab before it is projected again.
                if (workspaceDestinationNavigationIdentity(target, input.getCatalog()) !== null) {
                    if (!sameDestinationRef(retained, target)) input.dispatch({ type: 'setTarget', tabId: reusable.tabId, target });
                } else if (presentationPreview || (target.kind === 'session' && parseSessionPaneUrlState(target.params)?.details)) {
                    const adopted = adoptSessionTarget(retained, target);
                    if (!sameDestinationRef(retained, adopted)) input.dispatch({ type: 'setTarget', tabId: reusable.tabId, target: adopted });
                } else if (target.kind === 'project') {
                    // Opening the Project at its default page brings its tab forward as it was left;
                    // an addressed resource (a file, a commit, another page's state) retargets it.
                    if (!isProjectDefaultOpen(target) && !sameDestinationRef(retained, target)) {
                        input.dispatch({ type: 'setTarget', tabId: reusable.tabId, target });
                    }
                } else if (target.kind === 'session') {
                    const params = { ...retained.params,
                        ...(target.params.serverId ? { serverId: retained.params.serverId ?? target.params.serverId } : {}),
                        ...(target.params.accountId ? { accountId: target.params.accountId } : {}),
                    };
                    const qualified = { ...retained, params };
                    if (!sameDestinationRef(retained, qualified)) input.dispatch({ type: 'setTarget', tabId: reusable.tabId, target: qualified });
                }
                if (mode !== 'preview') input.dispatch({ type: 'promoteTab', tabId: reusable.tabId });
                input.dispatch({ type: 'activateTab', groupId: reusable.groupId, tabId: reusable.tabId });
            } else if (admittedSingleton) {
                if (admittedSingleton.length === 0) return false;
                retainSourcePreview();
                for (const action of admittedSingleton) input.dispatch(action);
                if (mode === 'newTab') input.dispatch({ type: 'promoteTab', tabId: focusedEntry().tabId });
            } else if (options.tabId && state.tabs[options.tabId] && !keepSourcePreview) {
                const group = Object.values(state.groups).find((item) => item.tabIds.includes(options.tabId!));
                if (!group) return false;
                finishOpen = sourceEntry
                    ? input.prepareOpen?.(sourceEntry, { tabId: options.tabId, groupId: group.id, target }, options) : undefined;
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
                    retainSourcePreview();
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
                        retainSourcePreview();
                        input.dispatch(action);
                    } else {
                        finishOpen = sourceEntry
                            ? input.prepareOpen?.(sourceEntry, { tabId: tab.id, groupId: openingGroupId, target }, options) : undefined;
                        retainSourcePreview();
                        input.dispatch(openAction);
                    }
                }
            }
            finishOpen?.(focusedEntry());
            visit(options.replace, projectUrl, true);
            options.onOpened?.();
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
            input.dispatch({ type: 'closeTabs', groupId, tabIds, newTab: createWorkspaceEmptyTab(input.createId()) });
            if (input.getState() !== state) visit();
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
            const current = focusedEntry();
            // Phone chrome mirrors an already selected pane into its fullscreen route.
            // That handoff (and its return) keeps the destination, Account lifetime and retained
            // source slot. An independently addressed Details resource still opens separately.
            const sameSession = (current.target.kind === 'session' || current.target.kind === 'sessionDetails')
                && (target.kind === 'session' || target.kind === 'sessionDetails')
                && sameSessionIdentity({ ...current.target, kind: 'session' }, { ...target, kind: 'session' });
            const currentDetails = parseSessionPaneUrlState(current.target.params)?.details;
            const nextDetails = parseSessionPaneUrlState(target.params)?.details;
            const detailsProjection = sameSession && (
                (current.target.kind === 'session' && target.kind === 'sessionDetails' && currentDetails !== undefined
                    && JSON.stringify(currentDetails) === JSON.stringify(nextDetails))
                || (current.target.kind === 'sessionDetails' && target.kind === 'session'
                    && (nextDetails === undefined || JSON.stringify(currentDetails) === JSON.stringify(nextDetails)))
                // A File page can update its location without becoming a new resource. In particular,
                // phone Track's line reveal and the page's route projection share the existing tab memory.
                || (current.target.kind === 'sessionDetails' && target.kind === 'sessionDetails'
                    && currentDetails?.kind === 'file' && nextDetails?.kind === 'file'
                    && currentDetails.path === nextDetails.path)
            );
            const currentSession = sessionIdentity(target)
                && findOpenDestination(target, input.getState(), undefined, current.tabId);
            const changedSessionParams = currentSession ? Object.entries(target.params).filter(([key, value]) =>
                key !== 'id' && key !== 'serverId' && key !== 'accountId' && current.target.params[key] !== value) : null;
            // Readiness may re-admit the cold URL after initialization. Its Home
            // alias and omitted view state must not replace the same current pane.
            if (sameDestinationRef(current.target, target) || changedSessionParams?.length === 0) {
                input.transport.adoptCurrent?.(current, history.index);
                return true;
            }
            // Phone cockpit selection changes the current view, not its retained pane.
            const phoneSelection = changedSessionParams?.length === 1 && changedSessionParams[0][0] === 'mobileSurface';
            return this.openHref(href, phoneSelection || detailsProjection ? { tabId: current.tabId } : {}, false);
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

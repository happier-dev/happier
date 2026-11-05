import { WORKSPACE_ACTION_INPUT_SCHEMAS, type WorkspaceActionId, type WorkspaceTabsListOutput, type WorkspaceClosedTabsListOutput, type WorkspaceFileOpenInput, type WorkspaceTabAddress, type PaneTabAddress } from '@happier-dev/protocol/actions/workspaceActionFamily';
import type { z } from 'zod/mini';
import type { AdmittedClientActionContext } from '@happier-dev/protocol/actions/actionExecutor';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import { createWorkspaceEmptyTab, sameDestinationRef, selectWorkspaceClosableTabIds, type ClosedWorkspaceTab, type WorkspaceState } from './workspaceState';
import type { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceSplit } from './workspaceSplit';
import type { FileFindSeedHandoff } from '../panes/fileFindSeedHandoff';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildWorkspaceFileLink } from '@/utils/url/sessionFileDeepLink';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { readProjectFileRouteTarget } from '@/components/projects/detail/projectRouteState';
import { readDestinationSessionAddress } from '../destinations/compactAppDestinationCatalog';
import type { getDesktopAppWindowTabPresentations, getDesktopAppWindowWorkspaceLayouts } from '@/desktop/window/appWindowRuntime';

type WorkspaceActionOwner = Readonly<Pick<WorkspaceTabAddress, 'serverId' | 'accountId' | 'layoutId'>>;
type WorkspaceListTab = WorkspaceTabsListOutput['tabs'][number];

function belongsToOwner(address: WorkspaceTabAddress, owner: WorkspaceActionOwner | undefined): boolean {
    return owner !== undefined && address.serverId === owner.serverId && address.accountId === owner.accountId
        && address.layoutId === owner.layoutId;
}

function sameTabAddress(first: WorkspaceTabAddress, second: WorkspaceTabAddress): boolean {
    return tabAddressKey(first) === tabAddressKey(second);
}

function tabAddressKey(address: WorkspaceTabAddress): string {
    return JSON.stringify(address.kind === 'workspaceTab'
        ? [address.kind, address.serverId, address.accountId, address.layoutId, address.tabId]
        : [address.kind, address.serverId, address.accountId, address.layoutId, address.scopeId, address.tabKey]);
}

function listTabKey(tab: WorkspaceListTab): string {
    return tab.address ? tabAddressKey(tab.address) : tab.id;
}

export type WorkspaceActionOutcome = Readonly<{ ok: true }> | WorkspaceTabsListOutput | WorkspaceClosedTabsListOutput
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; errorCode: string; error: string }>;
type ParsedWorkspaceRequest = {
    [Id in WorkspaceActionId]: Readonly<{ actionId: Id; data: z.output<(typeof WORKSPACE_ACTION_INPUT_SCHEMAS)[Id]> }>;
}[WorkspaceActionId];

export function workspaceActionFailure(errorCode: string): WorkspaceActionOutcome {
    return { ok: false, errorCode, error: errorCode };
}

/** The guard and effect consume the same admitted pane selection and pinned policy. */
export function selectWorkspaceTabsToClose(state: WorkspaceState, actionId: WorkspaceActionId, parameters: unknown, owner?: WorkspaceActionOwner): Readonly<{
    groupId: string;
    tabIds: readonly string[];
}> | null {
    const parsed = WORKSPACE_ACTION_INPUT_SCHEMAS[actionId].safeParse(parameters);
    if (!parsed.success) return null;
    const request = { actionId, data: parsed.data } as ParsedWorkspaceRequest;
    if (request.actionId === 'workspace.tabs.close_all') {
        const groupId = request.data.groupId ?? state.focusedGroupId;
        const group = state.groups[groupId];
        return group ? { groupId, tabIds: selectWorkspaceClosableTabIds(state, groupId, group.tabIds) } : null;
    }
    if (request.actionId !== 'workspace.tabs.close' && request.actionId !== 'workspace.tabs.close_others'
        && request.actionId !== 'workspace.tabs.close_left' && request.actionId !== 'workspace.tabs.close_right') return null;
    const address = request.actionId === 'workspace.tabs.close' ? request.data.address : undefined;
    if (address && (address.kind !== 'workspaceTab' || !belongsToOwner(address, owner))) return null;
    const tabId = address?.kind === 'workspaceTab' ? address.tabId : request.data.tabId;
    if (!tabId) return null;
    const group = Object.values(state.groups).find(candidate => candidate.tabIds.includes(tabId));
    if (!group) return null;
    if (request.actionId === 'workspace.tabs.close') return { groupId: group.id, tabIds: [tabId] };
    const index = group.tabIds.indexOf(tabId);
    const candidates = request.actionId === 'workspace.tabs.close_others' ? group.tabIds.filter(id => id !== tabId)
        : request.actionId === 'workspace.tabs.close_left' ? group.tabIds.slice(0, index) : group.tabIds.slice(index + 1);
    return { groupId: group.id, tabIds: selectWorkspaceClosableTabIds(state, group.id, candidates) };
}

export function projectWorkspaceTabsList(state: WorkspaceState, windowTabs: readonly WorkspaceListTab[] = [], owner?: WorkspaceActionOwner): WorkspaceTabsListOutput {
    const splits: WorkspaceTabsListOutput['splits'] = [];
    const collectSplits = (node: WorkspaceState['root']) => {
        if (node.kind !== 'split') return;
        splits.push({ id: node.id, axis: node.axis, ratio: node.ratio, firstNodeId: node.first.id, secondNodeId: node.second.id });
        collectSplits(node.first); collectSplits(node.second);
    };
    collectSplits(state.root);
    const byId = new Map(windowTabs.map(tab => [listTabKey(tab), tab]));
    const tabs: WorkspaceListTab[] = Object.values(state.groups).flatMap((group) => group.tabIds.map((id) => {
            const tab = state.tabs[id];
            const row = { id: tab.id, groupId: group.id, target: { kind: tab.target.kind, params: { ...tab.target.params } },
                ...(owner ? { address: { kind: 'workspaceTab' as const, ...owner, tabId: tab.id } } : {}),
                pinned: tab.pinned, preview: tab.preview,
                ...(tab.presentation ? { presentation: tab.presentation } : {}) };
            const windowTab = byId.get(listTabKey(row));
            return windowTab?.presentation ? { ...row, presentation: windowTab.presentation } : row;
        }));
    const localIds = new Set(tabs.map(listTabKey));
    tabs.push(...windowTabs.filter(tab => !localIds.has(listTabKey(tab))));
    return { ok: true, tabs,
        groups: Object.values(state.groups).map((group) => ({ id: group.id, tabIds: [...group.tabIds], activeTabId: group.activeTabId })),
        splits, rootNodeId: state.root.id, focusedGroupId: state.focusedGroupId, maximizedGroupId: state.maximizedGroupId,
    };
}

export type WorkspaceAppWindowActions = Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    readWindows: () => NonNullable<WorkspaceTabsListOutput['windows']>;
    activateWindow: (windowId: string) => Promise<boolean>;
    readLayouts: () => ReturnType<typeof getDesktopAppWindowWorkspaceLayouts>;
    readPresentations: typeof getDesktopAppWindowTabPresentations;
    activateTab: (address: WorkspaceTabAddress, context?: AdmittedClientActionContext) => Promise<boolean>;
    returnTab: (address: WorkspaceTabAddress) => Promise<boolean>;
    closeTab: (address: WorkspaceTabAddress, context?: AdmittedClientActionContext) => Promise<boolean>;
    moveTab?: (address: WorkspaceTabAddress, targetGroupId: string, beforeTabId?: string | null,
        context?: AdmittedClientActionContext) => Promise<boolean>;
    openHref?: (href: string) => Promise<WorkspaceActionOutcome> | null;
}>;

function projectWorkspaceWindowLayouts(state: WorkspaceState, windows: WorkspaceAppWindowActions, owner?: WorkspaceActionOwner): WorkspaceTabsListOutput {
    const presentations = windows.readPresentations();
    const sources = Object.values(state.tabs).flatMap(tab => {
        const target = { ...tab.target, params: { ...tab.target.params,
            serverId: tab.target.params.serverId ?? windows.scope.serverId,
            accountId: tab.target.params.accountId ?? windows.scope.accountId } };
        const presentation = presentations.find(candidate => candidate.tabId === tab.id
            && candidate.serverId === target.params.serverId && candidate.accountId === target.params.accountId
            && (!owner || candidate.layoutId === owner.layoutId));
        return presentation ? [{ windowId: presentation.windowId, target }] : [];
    });
    // A moved source and its mounted body are one public tab; a retargeted body remains distinct.
    const layouts = windows.readLayouts().map(({ windowId, layout }) => ({ windowId, layout: { ...layout,
        tabs: layout.tabs.filter(tab => !('target' in tab) || !sources.some(source => source.windowId === windowId
            && sameDestinationRef(source.target, tab.target))),
    } }));
    const result = projectWorkspaceTabsList(state, [], owner);
    result.windows = windows.readWindows();
    for (const tab of result.tabs) {
        if (!('target' in tab)) continue;
        const presentation = presentations.find(candidate => candidate.tabId === tab.id
            && candidate.serverId === (tab.address?.serverId ?? tab.target.params.serverId ?? windows.scope.serverId)
            && candidate.accountId === (tab.address?.accountId ?? tab.target.params.accountId ?? windows.scope.accountId)
            && candidate.layoutId === tab.address?.layoutId);
        if (presentation) tab.presentation = { windowId: presentation.windowId, focused: presentation.focused };
    }
    const localIds = new Set(result.tabs.map(listTabKey));
    for (const { windowId, layout } of layouts) {
        const appended = layout.tabs.filter(tab => !localIds.has(listTabKey(tab)));
        const groupId = (id: string) => `window:${JSON.stringify([windowId, id])}`;
        result.tabs.push(...appended.map(tab => 'target' in tab ? { ...tab, groupId: groupId(tab.groupId) } : tab));
        const appendedIds = new Set(appended.map(tab => tab.id));
        for (const group of layout.groups) {
            if (!group.tabIds.some(id => appendedIds.has(id))) continue;
            const paneGroup = appended.some(tab => !('target' in tab) && tab.groupId === group.id);
            result.groups.push({ ...group, id: paneGroup ? group.id : groupId(group.id),
                tabIds: group.tabIds.filter(id => appendedIds.has(id)) });
        }
    }
    return result;
}

function workspaceWindowMoveGroup(layouts: ReturnType<typeof getDesktopAppWindowWorkspaceLayouts>, address: WorkspaceTabAddress, requestedGroupId: string): string {
    for (const { windowId, layout } of layouts) {
        if (!layout.tabs.some(tab => tab.address && belongsToOwner(tab.address, address))) continue;
        const group = layout.groups.find(candidate => `window:${JSON.stringify([windowId, candidate.id])}` === requestedGroupId);
        if (group) return group.id;
    }
    return requestedGroupId;
}

/** Thin intent adapter. Navigation, preview policy, layout admission and persistence keep their existing owners. */
export function createWorkspaceActionAdapter(input: Readonly<{
    getState: () => WorkspaceState;
    navigation: ReturnType<typeof createWorkspaceNavigationAdapter>;
    readCanvas: () => SplitCanvasHostControls | null;
    createId: () => string;
    /** Mounted clients project history labels through the same live destination-title owner. */
    readClosedTitle?: (entry: ClosedWorkspaceTab) => string | null;
    phone?: boolean;
    /** The registered foreground Session driver owns silent file-pane positioning. */
    openFileInPlace?: (file: WorkspaceFileOpenInput, tabId?: string) => boolean;
    chatFind?: Readonly<{ handoff: FileFindSeedHandoff; resolveAuthority(serverId: string): ServerAccountScopeLifetime | null }>;
    owner?: WorkspaceActionOwner;
    panes?: Readonly<{
        listTabs: () => readonly WorkspaceListTab[];
        activateTab: (address: PaneTabAddress) => void;
        closeTab: (address: PaneTabAddress) => Promise<boolean>;
        moveTab: (address: PaneTabAddress, targetGroupId: string) => Promise<boolean>;
    }>;
    appWindows?: WorkspaceAppWindowActions;
}>) {
    const presented = (actionId: WorkspaceActionId, parameters: unknown, context?: AdmittedClientActionContext): Promise<WorkspaceActionOutcome> | null => {
        const windows = input.appWindows;
        if (!windows && !input.panes) return null;
        const parsed = WORKSPACE_ACTION_INPUT_SCHEMAS[actionId].safeParse(parameters);
        if (!parsed.success) return null;
        const request = { actionId, data: parsed.data } as ParsedWorkspaceRequest;
        if (request.actionId === 'workspace.tabs.open' && request.data.href) return windows?.openHref?.(request.data.href) ?? null;
        if (request.actionId !== 'workspace.tabs.activate' && request.actionId !== 'workspace.tabs.close'
            && request.actionId !== 'workspace.tabs.move') return null;
        if (request.actionId === 'workspace.tabs.activate' && request.data.windowId) {
            return (async () => windows && await windows.activateWindow(request.data.windowId!)
                ? { ok: true as const } : workspaceActionFailure('workspace_tab_not_found'))();
        }
        if (request.actionId === 'workspace.tabs.move' && input.phone) return Promise.resolve(workspaceActionFailure('workspace_operation_unavailable'));
        const explicit = request.data.address;
        if (explicit?.kind === 'paneTab') {
            const panes = input.panes;
            const pane = panes?.listTabs().find(tab => tab.address && sameTabAddress(tab.address, explicit));
            if (!panes || !pane || pane.presentation) {
                if (!windows) return Promise.resolve(workspaceActionFailure('workspace_tab_not_found'));
                return (async (): Promise<WorkspaceActionOutcome> => {
                    if (request.actionId === 'workspace.tabs.activate') return await windows.activateTab(explicit, context)
                        ? { ok: true } : workspaceActionFailure('workspace_tab_not_found');
                    if (request.actionId === 'workspace.tabs.close') return await windows.closeTab(explicit, context)
                        ? { ok: true } : workspaceActionFailure('workspace_navigation_cancelled');
                    return windows.moveTab
                        ? await windows.moveTab(explicit, request.data.targetGroupId, request.data.beforeTabId, context)
                            ? { ok: true } : workspaceActionFailure('workspace_navigation_cancelled')
                        : workspaceActionFailure('workspace_operation_unavailable');
                })();
            }
            return (async (): Promise<WorkspaceActionOutcome> => {
                if (request.actionId === 'workspace.tabs.activate') { panes.activateTab(explicit); return { ok: true }; }
                if (request.actionId === 'workspace.tabs.close') return await panes.closeTab(explicit)
                    ? { ok: true } : workspaceActionFailure('workspace_navigation_cancelled');
                return await panes.moveTab(explicit, request.data.targetGroupId)
                    ? { ok: true } : workspaceActionFailure('workspace_group_not_found');
            })();
        }
        if (!windows) return null;
        const tabId = explicit?.tabId ?? request.data.tabId;
        if (!tabId) return null;
        const state = input.getState();
        const local = !explicit || belongsToOwner(explicit, input.owner);
        const tab = local ? state.tabs[tabId] : undefined;
        const localAddress = tab && input.owner ? { kind: 'workspaceTab' as const, ...input.owner, tabId } : undefined;
        const selectedAddress = explicit ?? localAddress;
        const layouts = windows.readLayouts();
        const shown = layouts.flatMap(({ layout }) => layout.tabs).find(candidate =>
            'target' in candidate && (selectedAddress ? candidate.address && sameTabAddress(candidate.address, selectedAddress) : candidate.id === tabId));
        const shownTarget = shown && 'target' in shown ? shown.target : undefined;
        const target = tab?.target ?? shownTarget;
        const address = selectedAddress ?? shown?.address ?? { kind: 'workspaceTab' as const, tabId,
            serverId: target?.params.serverId ?? windows.scope.serverId,
            accountId: target?.params.accountId ?? windows.scope.accountId, layoutId: input.owner?.layoutId ?? 'main' };
        const placed = windows.readPresentations().some(candidate => candidate.tabId === tabId
            && candidate.serverId === address.serverId && candidate.accountId === address.accountId
            && candidate.layoutId === address.layoutId);
        if (local && !tab?.presentation && !shown?.presentation && !placed) return null;
        if (!explicit && !tab?.presentation && !shown?.presentation && !placed) return null;
        if (request.actionId === 'workspace.tabs.move' && local && !state.groups[request.data.targetGroupId]) {
            return Promise.resolve(workspaceActionFailure('workspace_group_not_found'));
        }
        return (async (): Promise<WorkspaceActionOutcome> => {
            if (request.actionId === 'workspace.tabs.activate') return await windows.activateTab(address, context)
                ? { ok: true } : workspaceActionFailure('workspace_tab_not_found');
            if (request.actionId === 'workspace.tabs.close') {
                if (!await windows.closeTab(address, context)) return workspaceActionFailure('workspace_navigation_cancelled');
                const source = local ? Object.values(input.getState().groups).find(group => group.tabIds.includes(tabId)) : undefined;
                if (source) input.navigation.closeTab(source.id, tabId);
                return { ok: true };
            }
            if (!local) return windows.moveTab
                ? await windows.moveTab(address, workspaceWindowMoveGroup(layouts, address, request.data.targetGroupId), request.data.beforeTabId, context)
                    ? { ok: true } : workspaceActionFailure('workspace_navigation_cancelled')
                : workspaceActionFailure('workspace_operation_unavailable');
            if (!await windows.returnTab(address)) return workspaceActionFailure('workspace_navigation_cancelled');
            const source = Object.values(input.getState().groups).find(group => group.tabIds.includes(tabId));
            if (!source) return workspaceActionFailure('workspace_tab_not_found');
            input.navigation.dispatch({ type: 'moveTab', tabId, sourceGroupId: source.id, targetGroupId: request.data.targetGroupId,
                ...(request.data.beforeTabId === undefined ? {} : { beforeTabId: request.data.beforeTabId }) });
            return { ok: true };
        })();
    };
    const execute = (actionId: WorkspaceActionId, parameters: unknown, context?: AdmittedClientActionContext): WorkspaceActionOutcome | Promise<WorkspaceActionOutcome> => {
        const windowResult = presented(actionId, parameters, context);
        if (windowResult) return windowResult;
        const parsed = WORKSPACE_ACTION_INPUT_SCHEMAS[actionId].safeParse(parameters);
        if (!parsed.success) return workspaceActionFailure('invalid_parameters');
        // The indexed schema validated exactly this action's input; preserve that correlation for narrowing.
        const request = { actionId, data: parsed.data } as ParsedWorkspaceRequest;
        const address = 'address' in request.data ? request.data.address : undefined;
        if (address && (address.kind !== 'workspaceTab' || !belongsToOwner(address, input.owner))) {
            return workspaceActionFailure('workspace_tab_not_found');
        }
        if (request.actionId === 'workspace.files.link.get') return { ok: true, url: buildWorkspaceFileLink(request.data) };
        // File addressing enters the incumbent href path after strict ingress validation.
        const normalized = request.actionId === 'workspace.tabs.open' && request.data.file
            ? { ...request, data: { ...request.data,
                href: `${buildWorkspaceFileLink(request.data.file)}&fileOpenAs=${request.data.mode === 'newTab' || request.data.mode?.startsWith('split') ? 'pinned' : 'preview'}`,
            } }
            : request;
        const { actionId: parsedActionId, data } = normalized;
        if (input.phone && (parsedActionId === 'workspace.tabs.move' || parsedActionId.startsWith('workspace.groups.')
            || parsedActionId === 'workspace.split' || parsedActionId === 'workspace.resize'
            || (parsedActionId === 'workspace.tabs.open' && (!('href' in data) || !data.href
                || ('mode' in data && data.mode?.startsWith('split')))))) {
            return workspaceActionFailure('workspace_operation_unavailable');
        }
        const state = input.getState();
        if (parsedActionId === 'workspace.tabs.closed.list') return { ok: true, tabs: state.recentlyClosed.map(entry => {
            const title = input.readClosedTitle ? input.readClosedTitle(entry) : entry.fallbackTitle;
            return { id: entry.tab.id, target: { kind: entry.tab.target.kind, params: { ...entry.tab.target.params } }, pinned: entry.tab.pinned,
                ...(title == null ? {} : { title }),
            };
        }) };
        if (parsedActionId === 'workspace.tabs.reopen') return input.navigation.reopenTab('tabId' in data ? data.tabId : undefined)
            ? { ok: true } : workspaceActionFailure('workspace_closed_tab_not_found');
        const requestedGroupId = 'groupId' in data && data.groupId ? data.groupId : undefined;
        const tabId = address?.kind === 'workspaceTab' ? address.tabId : 'tabId' in data ? data.tabId : undefined;
        const source = tabId ? Object.values(state.groups).find((group) => group.tabIds.includes(tabId)) : state.groups[requestedGroupId ?? state.focusedGroupId];
        const groupId = requestedGroupId ?? source?.id ?? state.focusedGroupId;
        if (tabId && !source) return workspaceActionFailure('workspace_tab_not_found');
        if ('groupId' in data && data.groupId && !state.groups[data.groupId]) return workspaceActionFailure('workspace_group_not_found');
        switch (parsedActionId) {
            case 'workspace.tabs.list': {
                const result = input.appWindows ? projectWorkspaceWindowLayouts(state, input.appWindows, input.owner)
                    : projectWorkspaceTabsList(state, [], input.owner);
                const listed = new Set(result.tabs.map(listTabKey));
                result.tabs.push(...(input.panes?.listTabs() ?? []).filter(tab => !listed.has(listTabKey(tab))));
                return result;
            }
            case 'workspace.tabs.open':
                if ('href' in data && data.href) {
                    const mode = 'mode' in data && data.mode ? data.mode : 'newTab';
                    const reuseExisting = 'reuseExisting' in data ? data.reuseExisting ?? true : true;
                    const direction = mode === 'splitLeft' ? 'left' : mode === 'splitRight' ? 'right'
                        : mode === 'splitUp' ? 'up' : mode === 'splitDown' ? 'down' : null;
                    const alreadyOpen = reuseExisting ? input.navigation.findOpenHref(data.href) : null;
                    const measurement = direction && !alreadyOpen
                        ? input.readCanvas()?.readSplitMeasurement(groupId, direction) : null;
                    if (direction && !measurement && !alreadyOpen) {
                        return workspaceActionFailure('workspace_layout_unmeasured');
                    }
                    let cancelFind: (() => void) | undefined;
                    if (data.find) {
                        const target = input.navigation.resolveOpenTarget(data.href);
                        const findTarget = data.find.target;
                        const serverId = findTarget.kind === 'native-message' ? target?.params.serverId : findTarget.serverId;
                        const authority = serverId ? input.chatFind?.resolveAuthority(serverId) : null;
                        if (!input.chatFind || !authority?.isCurrent()
                            || (target?.params.accountId && target.params.accountId !== authority.scope.accountId)) {
                            return workspaceActionFailure('workspace_find_unavailable');
                        }
                        if (findTarget.kind === 'native-message') {
                            if (target?.kind !== 'session' || !target.params.id) return workspaceActionFailure('workspace_find_unavailable');
                            cancelFind = input.chatFind.handoff.stageChat({ sessionId: target.params.id,
                                serverId: authority.scope.serverId, accountId: authority.scope.accountId }, { ...data.find, target: findTarget }, authority);
                        } else {
                            const isSession = findTarget.kind === 'session-file';
                            const sessionAddress = target ? readDestinationSessionAddress(target) : null;
                            const addressedFile = isSession
                                ? sessionAddress && target ? parseSessionPaneUrlState(target.params)?.details : null
                                : target?.kind === 'project' ? readProjectFileRouteTarget(target.params) : null;
                            if (addressedFile?.kind !== 'file' || addressedFile.path !== findTarget.path
                                || (isSession ? sessionAddress?.sessionId !== findTarget.sessionId
                                    : target?.kind !== 'project' || target.params.workspaceRefId !== findTarget.workspaceRefId)
                                || (target?.params.serverId && target.params.serverId !== findTarget.serverId)
                                || authority.scope.serverId !== findTarget.serverId) return workspaceActionFailure('workspace_find_unavailable');
                            cancelFind = input.chatFind.handoff.stage({ host: isSession ? 'session' : 'project',
                                id: isSession ? findTarget.sessionId : findTarget.workspaceRefId,
                                accountId: authority.scope.accountId, scope: { serverId: findTarget.serverId,
                                    machineId: findTarget.machineId, rootPath: findTarget.rootPath }, path: findTarget.path },
                            { query: data.find.query, options: data.find.options ?? { matchCase: false, regex: false },
                                target: { kind: 'file', path: findTarget.path, ...(findTarget.anchor ? { anchor: findTarget.anchor } : {}) } }, authority);
                        }
                        if (!authority.isCurrent()) { cancelFind(); return workspaceActionFailure('workspace_find_unavailable'); }
                    }
                    try {
                        if (data.present === false) {
                            if (!data.file || !input.openFileInPlace?.(data.file, tabId)) {
                                cancelFind?.();
                                return workspaceActionFailure('workspace_file_pane_unavailable');
                            }
                            return { ok: true };
                        }
                        if (!input.navigation.openHref(data.href, {
                            ...(tabId ? { tabId } : {}),
                            ...('groupId' in data && data.groupId ? { groupId: data.groupId } : {}),
                            ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                            mode, reuseExisting,
                            ...('replace' in data ? { replace: data.replace } : {}),
                            ...(measurement ? { availableSizePx: measurement.availableSizePx, minimumFirstSizePx: measurement.minimumExistingSizePx } : {}),
                        })) { cancelFind?.(); return workspaceActionFailure('workspace_destination_unavailable'); }
                    } catch (error) { cancelFind?.(); throw error; }
                } else {
                    if (tabId) return workspaceActionFailure('invalid_parameters');
                    input.navigation.dispatch({ type: 'openTab', groupId, tab: createWorkspaceEmptyTab(input.createId()),
                        ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                    });
                }
                break;
            case 'workspace.tabs.activate':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                input.navigation.activateTab(source.id, tabId);
                break;
            case 'workspace.tabs.close':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                input.navigation.closeTab(source.id, tabId);
                break;
            case 'workspace.tabs.close_others':
            case 'workspace.tabs.close_left':
            case 'workspace.tabs.close_right':
            case 'workspace.tabs.close_all': {
                const selection = selectWorkspaceTabsToClose(state, parsedActionId, parameters, input.owner);
                if (!selection) return workspaceActionFailure('workspace_group_not_found');
                input.navigation.closeTabs(selection.groupId, selection.tabIds);
                break;
            }
            case 'workspace.tabs.pin':
                if (tabId && 'pinned' in data) input.navigation.dispatch({ type: 'setPinned', tabId, pinned: data.pinned });
                break;
            case 'workspace.tabs.move':
                if (!tabId || !source || !('targetGroupId' in data) || !state.groups[data.targetGroupId]) return workspaceActionFailure('workspace_group_not_found');
                input.navigation.dispatch({ type: 'moveTab', tabId, sourceGroupId: source.id, targetGroupId: data.targetGroupId,
                    ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                });
                break;
            case 'workspace.tabs.reorder':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                if ('index' in data) {
                    if (data.index >= source.tabIds.length) return workspaceActionFailure('workspace_tab_index_out_of_range');
                    input.navigation.dispatch({ type: 'reorderTab', groupId: source.id, tabId, index: data.index });
                } else if ('beforeTabId' in data) {
                    input.navigation.dispatch({ type: 'reorderTab', groupId: source.id, tabId, beforeTabId: data.beforeTabId });
                }
                break;
            case 'workspace.groups.focus': input.navigation.dispatch({ type: 'focusGroup', groupId }); break;
            case 'workspace.groups.maximize':
                if (state.maximizedGroupId !== groupId) input.navigation.dispatch({ type: 'toggleMaximize', groupId });
                break;
            case 'workspace.groups.restore': input.navigation.dispatch({ type: 'restoreMaximize' }); break;
            case 'workspace.split': {
                if (!source || !('direction' in data)) return workspaceActionFailure('workspace_group_not_found');
                const measurement = input.readCanvas()?.readSplitMeasurement(groupId, data.direction);
                if (!measurement) return workspaceActionFailure('workspace_layout_unmeasured');
                const action = createWorkspaceSplit(state, { groupId, ...(tabId ? { tabId } : {}), direction: data.direction,
                    ...measurement, createId: input.createId });
                if (!action) return workspaceActionFailure('workspace_split_unavailable');
                input.navigation.dispatch(action);
                break;
            }
            case 'workspace.resize':
                if (!('splitId' in data) || !('ratio' in data) || !input.readCanvas()?.resizeSplit(data.splitId, data.ratio)) return workspaceActionFailure('workspace_layout_unmeasured');
                break;
        }
        return { ok: true };
    };
    return Object.assign(execute, { presented });
}

import { flushSync } from 'react-dom';
import { getActionSpec, type DesktopWindowsOpenInput, type DesktopWindowsOpenResult } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { hrefForDestinationRef, resolveDestinationRefFromHref, type CompactAppDestination, type DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { WorkspaceAction, WorkspaceState, WorkspaceTab } from '@/components/appShell/workspace/workspaceState';
import { reduceWorkspaceState, sameDestinationRef } from '@/components/appShell/workspace/workspaceState';
import { parseWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey } from '@/components/appShell/workspace/workspacePersistence';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { projectWorkspaceTabsList } from '@/components/appShell/workspace/workspaceActions';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import type { WorkspaceTabsListOutput, WorkspaceTabAddress, PaneTabAddress } from '@happier-dev/protocol/actions/workspaceActionFamily';
import type { AdmittedClientActionContext } from '@happier-dev/protocol/actions/actionExecutor';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { randomUUID } from '@/platform/randomUUID';
import { getDesktopHostAvailability, getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { prepareMountedTabPresentationTransfer } from '@/utils/navigation/runGuardedNavigation';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { desktopSessionTargetForDestination, type AppWindowRecord } from './appWindowBoot';
import { resolveWindowPlacement, type WindowRect } from './windowPlacement';
import { getDesktopAppWindowMountedSurfaces, getFocusedDesktopAppWindowSurface } from './appWindowSurface';
import { currentUiContextCommandClientRpcMethod, currentUiContextReadClientRpcMethod,
    mountedWorkReadClientRpcMethod, sessionUiActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { isWorkflowAuthoringActionId, workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { TokenStorage } from '@/auth/storage/tokenStorage';
export { useDesktopHomeResponder } from './useDesktopHomeResponder';

type WorkspaceOwner = Readonly<{
    windowId: string | null;
    layoutId?: string;
    scope: Readonly<{ serverId: string; accountId: string }>;
    getState: () => WorkspaceState;
    dispatch: (action: WorkspaceAction) => void;
    catalog: readonly CompactAppDestination[];
    activateTab: (tabId: string) => void;
    panes?: Readonly<{
        list: (address: PaneTabAddress) => WorkspaceTabsListOutput['tabs'];
        prepare: (address: PaneTabAddress) => Promise<boolean>;
        resolveTarget: (address: PaneTabAddress) => Extract<AppWindowRecord['selectedAddress'], { kind: 'paneTab' }> | null;
        setPresentation: (address: PaneTabAddress, windowId: string | null) => void;
        clearPresentations: (windowId: string) => void;
        activate: (address: PaneTabAddress) => void;
        close: (address: PaneTabAddress) => Promise<boolean>;
        move: (address: PaneTabAddress, targetGroupId: string, beforeMove?: () => Promise<boolean>) => Promise<boolean>;
    }>;
    placementMetrics: Readonly<{ cascadeOffset: number; screenInset: number }>;
    onRestoreError?: (error: unknown, retry?: () => void) => void;
}>;
type LifecycleEvent = Readonly<{ kind: 'ready' | 'focused' | 'return' | 'destroyed' | 'failed'; windowId: string; focused?: boolean; error?: string }>;
type OpenResult = Readonly<{ windowId: string; windowLabel: string; ready: boolean; reused: boolean }>;

let workspace: WorkspaceOwner | null = null;
let lifecycle: Promise<() => void> | null = null;
let initialization: Promise<void> = Promise.resolve();
const records = new Map<string, AppWindowRecord>();
type WindowOperation = Readonly<{
    record: AppWindowRecord;
    done: Promise<void>;
    finish: () => void;
    ready: Promise<void>;
    resolveReady: () => void;
    rejectReady: (error: Error) => void;
}>;
const operations = new Map<string, WindowOperation>();
const subscribers = new Set<() => void>();
const transferSubscribers = new Set<() => void>();
let transfers: readonly string[] = [];
type PlacedTab = Readonly<{ windowId: string; serverId: string; accountId: string; layoutId: string; tabId: string }>;
let placedTabs: readonly PlacedTab[] = [];
let focusedDestinationWindowId: string | null = null;

function sourceLayouts(): readonly Readonly<{ key: string; serverId: string; accountId: string; layoutId: string; state: WorkspaceState }>[] {
    // Native records supply live window identities; tab placement stays in its source layout.
    for (const record of records.values()) if (record.sourceLayoutId) workspaceLayoutsState.read(workspaceLayoutScopeKey({
        serverId: record.homeId, accountId: record.accountId, windowId: record.sourceLayoutId,
    }));
    const keys = new Set(Object.keys(workspaceLayoutsState.readAll()));
    const currentOwner = workspace;
    const currentLayoutId = currentOwner?.layoutId ?? currentOwner?.windowId;
    if (currentOwner && currentLayoutId) keys.add(workspaceLayoutScopeKey({
        ...currentOwner.scope, windowId: currentLayoutId,
    }));
    return [...keys].flatMap(key => {
        let scope: unknown;
        try { scope = JSON.parse(key); } catch { return []; }
        if (!Array.isArray(scope) || scope.length !== 3 || !scope.every(part => typeof part === 'string')) return [];
        const [serverId, accountId, layoutId] = scope as string[];
        const owner = workspace;
        const current = owner?.scope.serverId === serverId && owner.scope.accountId === accountId
            && (owner.layoutId ?? owner.windowId) === layoutId;
        const state = current ? owner.getState() : parseWorkspaceLayout(workspaceLayoutsState.readStrict(key, value => value));
        return state ? [{ key, serverId, accountId, layoutId, state }] : [];
    });
}

function clearPlacement(windowId: string, address?: DesktopAppWindowTabAddress): void {
    if (!address) workspace?.panes?.clearPresentations(windowId);
    for (const layout of sourceLayouts()) {
        if (address && (layout.serverId !== address.serverId || layout.accountId !== address.accountId
            || (address.layoutId && layout.layoutId !== address.layoutId))) continue;
        const owner = workspace;
        const current = owner?.scope.serverId === layout.serverId && owner.scope.accountId === layout.accountId
            && (owner.layoutId ?? owner.windowId) === layout.layoutId;
        let state = layout.state;
        for (const tab of Object.values(state.tabs)) if (tab.presentation?.windowId === windowId && (!address || tab.id === address.tabId)) {
            const action = { type: 'setPresentation', tabId: tab.id, presentation: null } as const;
            if (current) owner.dispatch(action);
            else state = reduceWorkspaceState(state, action);
        }
        if (!current && state !== layout.state) workspaceLayoutsState.set(layout.key, serializeWorkspaceLayout(state));
    }
}

function adoptRecords(snapshot: readonly AppWindowRecord[]): void {
    const retired = [...records.keys()].filter(id => !snapshot.some(record => record.windowId === id));
    if (focusedDestinationWindowId && retired.includes(focusedDestinationWindowId)) focusedDestinationWindowId = null;
    for (const id of retired) clearPlacement(id);
    records.clear();
    for (const record of snapshot) records.set(record.windowId, record);
    publishRecords();
}

function publishRecords(): void {
    const nextPlacedTabs: PlacedTab[] = [];
    for (const layout of sourceLayouts()) for (const tab of Object.values(layout.state.tabs)) {
        const windowId = tab.presentation?.windowId;
        if (windowId && records.has(windowId) && !nextPlacedTabs.some(placed => placed.windowId === windowId
            && placed.tabId === tab.id && placed.serverId === layout.serverId && placed.accountId === layout.accountId
            && placed.layoutId === layout.layoutId)) {
            nextPlacedTabs.push({ windowId, serverId: layout.serverId, accountId: layout.accountId, layoutId: layout.layoutId, tabId: tab.id });
        }
    }
    for (const record of records.values()) if (record.sourceTabId && !nextPlacedTabs.some(placed =>
        placed.windowId === record.windowId && placed.tabId === record.sourceTabId)) {
        nextPlacedTabs.push({ windowId: record.windowId, serverId: record.homeId, accountId: record.accountId,
            layoutId: record.sourceLayoutId ?? record.layoutId, tabId: record.sourceTabId });
    }
    if (JSON.stringify(nextPlacedTabs) !== JSON.stringify(placedTabs)) placedTabs = nextPlacedTabs;
    for (const subscriber of subscribers) subscriber();
}

function transfer(tabId: string, pending: boolean): void {
    if (pending === transfers.includes(tabId)) return;
    flushSync(() => {
        transfers = pending ? [...transfers, tabId] : transfers.filter(id => id !== tabId);
        for (const subscriber of transferSubscribers) subscriber();
    });
}

function beginOperation(record: AppWindowRecord): WindowOperation {
    let finish!: () => void;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A native destruction can arrive while invoke(open) is still settling.
    void ready.catch(() => {});
    const operation = { record, done, finish, ready, resolveReady, rejectReady };
    operations.set(record.windowId, operation);
    return operation;
}

function finishOperation(operation: WindowOperation): void {
    if (operations.get(operation.record.windowId) === operation) operations.delete(operation.record.windowId);
    operation.finish();
}

export const getDesktopAppWindowTransfers = (): readonly string[] => transfers;
export function subscribeDesktopAppWindowTransfers(listener: () => void): () => void {
    transferSubscribers.add(listener); return () => { transferSubscribers.delete(listener); };
}
export const getDesktopAppWindowPlacedTabs = (): readonly PlacedTab[] => placedTabs;
export function subscribeDesktopAppWindows(listener: () => void): () => void {
    subscribers.add(listener); return () => { subscribers.delete(listener); };
}

export type DesktopAppWindowTabAddress = Readonly<{ tabId: string; serverId: string; accountId: string; layoutId?: string }>;

function focused(record: AppWindowRecord): boolean {
    if (record.selectedAddress.kind !== 'session') return focusedDestinationWindowId === record.windowId;
    const address = getFocusedSessionAddress();
    return address?.sessionId === record.selectedAddress.sessionId && address.serverId === record.homeId;
}

export function getDesktopAppWindowTabPresentations(): readonly (PlacedTab & Readonly<{ focused: boolean }>)[] {
    return placedTabs.map(tab => ({ ...tab, focused: focused(records.get(tab.windowId)!) }));
}

/** Native records also describe full shells with no tabs; layouts remain their content owner. */
export function getDesktopAppWindows(scope: Readonly<{ serverId: string; accountId: string }>): NonNullable<WorkspaceTabsListOutput['windows']> {
    const active = getFocusedDesktopAppWindowSurface();
    const owner = workspace;
    const windows: NonNullable<WorkspaceTabsListOutput['windows']> = [...records.values()]
        .filter(record => record.homeId === scope.serverId && record.accountId === scope.accountId)
        .map(record => ({ windowId: record.windowId, role: 'secondary', chrome: record.chrome ?? 'destination',
            serverId: record.homeId, accountId: record.accountId, layoutId: record.layoutId,
            focused: active?.windowId === record.windowId }));
    if (owner?.windowId === 'main' && owner.scope.serverId === scope.serverId && owner.scope.accountId === scope.accountId) {
        windows.unshift({ windowId: 'main', role: 'primary', chrome: 'full', ...scope,
            layoutId: owner.layoutId ?? 'main', focused: active?.windowId === 'main' });
    }
    return windows;
}

export async function focusDesktopAppWindow(windowId: string, scope: Readonly<{ serverId: string; accountId: string }>): Promise<boolean> {
    const record = records.get(windowId);
    if (record?.homeId === scope.serverId && record.accountId === scope.accountId) {
        await invokeDesktopHost('desktop_app_window_open', { record });
        return true;
    }
    if (windowId === 'main' && workspace?.scope.serverId === scope.serverId && workspace.scope.accountId === scope.accountId) {
        await invokeDesktopHost('desktop_show_main_window');
        return true;
    }
    return false;
}

/** Read the destination's existing layout; no-source tabs are never fabricated in main. */
export function getDesktopAppWindowWorkspaceLayouts(scope?: Readonly<{ serverId: string; accountId: string }>): readonly Readonly<{
    windowId: string; layout: WorkspaceTabsListOutput;
}>[] {
    return [...records.values()].flatMap<{ windowId: string; layout: WorkspaceTabsListOutput }>(record => {
        if (scope && (scope.serverId !== record.homeId || scope.accountId !== record.accountId)) return [];
        if (record.selectedAddress.kind === 'paneTab') {
            const selected = record.selectedAddress;
            const tabs = workspace?.panes?.list({ ...selected, serverId: record.homeId, accountId: record.accountId })
                .filter(tab => 'kind' in tab && tab.kind === 'paneTab' && tab.tabKey === selected.tabKey)
                .map(tab => ({ ...tab, presentation: { windowId: record.windowId, focused: focused(record) } })) ?? [];
            if (!tabs.length) return [];
            const groupId = tabs[0].groupId;
            return [{ windowId: record.windowId, layout: { ok: true as const, tabs,
                groups: [{ id: groupId, tabIds: tabs.map(tab => tab.id), activeTabId: tabs[0].id }],
                splits: [], rootNodeId: groupId, focusedGroupId: groupId, maximizedGroupId: null } }];
        }
        const key = workspaceLayoutScopeKey({ serverId: record.homeId, accountId: record.accountId, windowId: record.layoutId });
        const owner = workspace;
        const state = owner?.windowId === record.windowId ? owner.getState()
            : parseWorkspaceLayout(workspaceLayoutsState.readStrict(key, value => value));
        if (!state) return [];
        const layout = projectWorkspaceTabsList(state, [], { serverId: record.homeId, accountId: record.accountId, layoutId: record.layoutId });
        return [{ windowId: record.windowId, layout: { ...layout, tabs: layout.tabs.flatMap(tab => 'target' in tab ? [{ ...tab,
            target: { ...tab.target, params: { ...tab.target.params, serverId: record.homeId, accountId: record.accountId } },
            presentation: { windowId: record.windowId, focused: focused(record) },
        }] : []) } }];
    });
}

export function getDesktopAppWindowWorkspaceTabs(scope?: Readonly<{ serverId: string; accountId: string }>): WorkspaceTabsListOutput['tabs'] {
    return getDesktopAppWindowWorkspaceLayouts(scope).flatMap(window => window.layout.tabs);
}

function placedWindow(address: DesktopAppWindowTabAddress): AppWindowRecord | undefined {
    const placed = placedTabs.find(tab => tab.tabId === address.tabId && tab.serverId === address.serverId && tab.accountId === address.accountId
        && (!address.layoutId || tab.layoutId === address.layoutId));
    if (placed) return records.get(placed.windowId);
    const listed = getDesktopAppWindowWorkspaceLayouts(address).find(window => (!address.layoutId || records.get(window.windowId)?.layoutId === address.layoutId)
        && window.layout.tabs.some(tab => tab.id === address.tabId));
    return listed ? records.get(listed.windowId) : undefined;
}

function destinationForRecord(record: AppWindowRecord): DestinationRef | null {
    if (record.selectedAddress.kind === 'destination') return record.selectedAddress.target;
    if (record.selectedAddress.kind === 'session') return { kind: 'session', params: {
        id: record.selectedAddress.sessionId, serverId: record.homeId, accountId: record.accountId,
    } };
    if (record.selectedAddress.kind !== 'workspaceTab' || !record.sourceLayoutId) return null;
    const tabId = record.selectedAddress.tabId;
    return sourceLayouts().find(layout => layout.serverId === record.homeId && layout.accountId === record.accountId
        && layout.layoutId === record.sourceLayoutId)?.state.tabs[tabId]?.target ?? null;
}

function sameWindowDestination(record: AppWindowRecord, destination: DestinationRef, scope: Readonly<{ serverId: string; accountId: string }>): boolean {
    if (record.homeId !== scope.serverId || record.accountId !== scope.accountId) return false;
    const existing = destinationForRecord(record);
    if (!existing) return false;
    if (existing.kind === 'session' && destination.kind === 'session') return existing.params.id === destination.params.id;
    return sameDestinationRef({ ...existing, params: { ...existing.params, ...scope } },
        { ...destination, params: { ...destination.params, ...scope } });
}

function paneWindow(address: PaneTabAddress): AppWindowRecord | undefined {
    return [...records.values()].find(record => record.homeId === address.serverId && record.accountId === address.accountId
        && record.selectedAddress.kind === 'paneTab' && record.selectedAddress.layoutId === address.layoutId
        && record.selectedAddress.scopeId === address.scopeId && record.selectedAddress.tabKey === address.tabKey);
}

export async function focusDesktopAppWindowTab(address: DesktopAppWindowTabAddress | WorkspaceTabAddress, context?: AdmittedClientActionContext): Promise<boolean> {
    if ('kind' in address && address.kind === 'paneTab') {
        const record = paneWindow(address);
        return record ? (await openDesktopAppWindow({ windowId: record.windowId, target: address })).status !== 'cancelled' : false;
    }
    const record = placedWindow(address);
    if (!record) return false;
    if (record.chrome === 'full') {
        if (!context) return false;
        const { executeDesktopAppWindowAdmittedAction } = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
        const result = await executeDesktopAppWindowAdmittedAction(`destination_${record.windowId}`, {
            actionId: 'workspace.tabs.activate', input: { tabId: address.tabId },
            context: { ...context, serverId: address.serverId, runtimeAccountId: address.accountId, expectedAccountId: address.accountId },
        });
        return result.ok && await focusDesktopAppWindow(record.windowId, address);
    }
    const tab = sourceLayouts().find(layout => layout.serverId === address.serverId && layout.accountId === address.accountId
        && (!address.layoutId || layout.layoutId === address.layoutId) && layout.state.tabs[address.tabId])?.state.tabs[address.tabId];
    const sessionId = tab?.target.kind === 'session' ? tab.target.params.id
        : record.selectedAddress.kind === 'session' ? record.selectedAddress.sessionId : null;
    if (!sessionId) {
        const destination = tab?.target ?? destinationForRecord(record);
        if (!destination) return false;
        if (tab) return (await openDesktopAppWindow({ windowId: record.windowId, target: { kind: 'workspaceTab',
            tabId: tab.id, serverId: address.serverId, accountId: address.accountId, ...(record.sourceLayoutId ? { layoutId: record.sourceLayoutId } : {}) } })).status !== 'cancelled';
        const href = hrefForDestinationRef(workspace?.catalog ?? [], destination);
        return href ? (await openDesktopAppWindow({ windowId: record.windowId, target: { kind: 'destination',
            href, serverId: address.serverId, accountId: address.accountId } })).status !== 'cancelled' : false;
    }
    return (await openDesktopAppWindow({ windowId: record.windowId, target: { kind: 'session',
        sessionId, serverId: address.serverId, accountId: address.accountId } })).status !== 'cancelled';
}

export async function returnDesktopAppWindowTab(address: DesktopAppWindowTabAddress | WorkspaceTabAddress): Promise<boolean> {
    if ('kind' in address && address.kind === 'paneTab') {
        const record = paneWindow(address);
        if (!record || !await returnWindow(record.windowId)) return false;
        workspace?.panes?.activate(address);
        return true;
    }
    const record = placedWindow(address);
    if (!record) return false;
    const owner = workspace;
    const recipientAddress = address.layoutId ? address.layoutId === record.layoutId : !owner?.getState().tabs[address.tabId];
    const noSourceTab = recipientAddress ? getDesktopAppWindowWorkspaceTabs(address)
        .find(tab => tab.id === address.tabId && tab.presentation?.windowId === record.windowId) : null;
    if (!await returnWindow(record.windowId)) return false;
    let returnedTabId = address.tabId;
    if (owner && noSourceTab && 'target' in noSourceTab && owner.scope.serverId === address.serverId && owner.scope.accountId === address.accountId) {
        const state = owner.getState();
        const target = noSourceTab.target;
        const existing = Object.values(state.tabs).find(tab => sameDestinationRef(
            { ...tab.target, params: { ...owner.scope, ...tab.target.params } },
            { ...target, params: { ...owner.scope, ...target.params } },
        ));
        returnedTabId = existing?.id ?? (state.tabs[noSourceTab.id] ? randomUUID() : noSourceTab.id);
        if (!existing) owner.dispatch({ type: 'openTab', groupId: state.focusedGroupId,
            tab: { id: returnedTabId, target, pinned: noSourceTab.pinned, preview: false } });
    }
    if (owner?.scope.serverId === address.serverId && owner.scope.accountId === address.accountId
        && (recipientAddress || !address.layoutId || (owner.layoutId ?? owner.windowId) === address.layoutId)) {
        owner.activateTab(returnedTabId);
    }
    return true;
}

export async function closeDesktopAppWindowTab(address: DesktopAppWindowTabAddress | WorkspaceTabAddress, context?: AdmittedClientActionContext): Promise<boolean> {
    if ('kind' in address && address.kind === 'paneTab') {
        const record = paneWindow(address);
        // Release the real body through its mounted guard, then remove membership
        // through the same source pane owner used by an ordinary Details close.
        if (!record || !await returnWindow(record.windowId, 'close')) return false;
        return await workspace?.panes?.close(address) ?? false;
    }
    const record = placedWindow(address);
    if (!record) return false;
    const source = sourceLayouts().find(layout => layout.serverId === address.serverId && layout.accountId === address.accountId
        && (!address.layoutId || layout.layoutId === address.layoutId)
        && layout.state.tabs[address.tabId]?.presentation?.windowId === record.windowId)?.state.tabs[address.tabId];
    const target = source ? { ...source.target, params: { ...source.target.params,
        serverId: source.target.params.serverId ?? address.serverId, accountId: source.target.params.accountId ?? address.accountId } } : null;
    const destination = getDesktopAppWindowWorkspaceTabs(address).find(tab => tab.presentation?.windowId === record.windowId
        && 'target' in tab && (tab.id === address.tabId || (target && sameDestinationRef(tab.target, target))));
    // An earlier rail source is already unmounted; its existing source owner closes it.
    if (!destination) { clearPlacement(record.windowId, address); publishRecords(); return true; }
    if (!context) return false;
    const { executeDesktopAppWindowAdmittedAction } = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
    const result = await executeDesktopAppWindowAdmittedAction(`destination_${record.windowId}`, {
        actionId: 'workspace.tabs.close', input: { tabId: destination.id },
        context: { ...context,
            serverId: address.serverId, runtimeAccountId: address.accountId, expectedAccountId: address.accountId },
    });
    if (!result.ok) return false;
    return record.chrome === 'full' || returnWindow(record.windowId);
}

/** A qualified move stays with its existing layout or pane owner. */
export async function moveDesktopAppWindowTab(address: WorkspaceTabAddress, targetGroupId: string,
    beforeTabId?: string | null, context?: AdmittedClientActionContext): Promise<boolean> {
    if (address.kind === 'paneTab') {
        const record = paneWindow(address);
        if (!record) return false;
        return await workspace?.panes?.move(address, targetGroupId, () => returnWindow(record.windowId)) ?? false;
    }
    const source = sourceLayouts().find(layout => layout.serverId === address.serverId && layout.accountId === address.accountId
        && layout.layoutId === address.layoutId && layout.state.tabs[address.tabId]);
    if (!source?.state.groups[targetGroupId]) return false;
    const record = placedWindow(address);
    if (record?.layoutId === address.layoutId && record.windowId !== workspace?.windowId) {
        if (!context) return false;
        const { executeDesktopAppWindowAdmittedAction } = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
        return (await executeDesktopAppWindowAdmittedAction(`destination_${record.windowId}`, {
            actionId: 'workspace.tabs.move', input: { address, targetGroupId, ...(beforeTabId ? { beforeTabId } : {}) },
            context: { ...context, serverId: address.serverId, runtimeAccountId: address.accountId, expectedAccountId: address.accountId },
        })).ok;
    }
    if (record && !await returnWindow(record.windowId)) return false;
    const sourceGroup = Object.values(source.state.groups).find(group => group.tabIds.includes(address.tabId));
    if (!sourceGroup) return false;
    const action = { type: 'moveTab', tabId: address.tabId, sourceGroupId: sourceGroup.id, targetGroupId,
        ...(beforeTabId === undefined ? {} : { beforeTabId }) } as const;
    const owner = workspace;
    if (owner && owner.scope.serverId === address.serverId && owner.scope.accountId === address.accountId
        && (owner.layoutId ?? owner.windowId) === address.layoutId) owner.dispatch(action);
    else {
        const current = parseWorkspaceLayout(workspaceLayoutsState.readStrict(source.key, value => value));
        if (!current) return false;
        workspaceLayoutsState.set(source.key, serializeWorkspaceLayout(reduceWorkspaceState(current, action)));
    }
    return true;
}

function sessionForTab(tab: WorkspaceTab, owner: Pick<WorkspaceOwner, 'scope'>): ExactSessionMachineTargetIdentity | null {
    return tab.target.kind === 'session' && tab.target.params.id ? {
        sessionId: tab.target.params.id,
        serverId: tab.target.params.serverId ?? owner.scope.serverId,
        accountId: tab.target.params.accountId ?? owner.scope.accountId,
    } : null;
}

async function returnWindow(windowId: string, intent: 'return' | 'close' = 'return'): Promise<boolean> {
    const pending = operations.get(windowId);
    if (pending) await pending.done;
    const record = records.get(windowId);
    if (!record) return false;
    const operation = beginOperation(record);
    const bridge = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
    let released = false;
    try {
        released = getDesktopHostWindowLabel() === `destination_${windowId}`
            ? await bridge.prepareDesktopAppWindowReturn(intent) : await bridge.requestDesktopAppWindowReturn(`destination_${windowId}`, intent);
        if (!released) return false;
        if (record.chrome !== 'full' && record.selectedAddress.kind === 'session') {
            const { resumeSessionDraftWindowPresentation } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
            const release = await resumeSessionDraftWindowPresentation({ sessionId: record.selectedAddress.sessionId,
                serverId: record.homeId, accountId: record.accountId });
            release();
        }
        // The native snapshot retires placement in every source renderer before remount.
        await invokeDesktopHost('desktop_app_window_close', { windowId });
        if (focusedDestinationWindowId === windowId) focusedDestinationWindowId = null;
        clearPlacement(windowId);
        records.delete(windowId); publishRecords();
        return true;
    } catch (error) {
        if (released) await bridge.requestDesktopAppWindowResume(`destination_${windowId}`);
        throw error;
    } finally {
        finishOperation(operation);
    }
}

async function onLifecycle(event: LifecycleEvent): Promise<void> {
    if (event.kind === 'ready') { operations.get(event.windowId)?.resolveReady(); return; }
    if (event.kind === 'failed') { operations.get(event.windowId)?.rejectReady(new Error(event.error ?? 'presentation_unavailable')); return; }
    if (event.kind === 'return') { await returnWindow(event.windowId); return; }
    if (event.kind === 'destroyed') {
        if (focusedDestinationWindowId === event.windowId) focusedDestinationWindowId = null;
        operations.get(event.windowId)?.rejectReady(new Error('desktop_app_window_destroyed'));
        clearPlacement(event.windowId);
        records.delete(event.windowId); publishRecords(); return;
    }
    const record = records.get(event.windowId);
    const previousDestinationFocus = focusedDestinationWindowId;
    const wasFocused = record ? focused(record) : false;
    if (event.focused) focusedDestinationWindowId = record && record.selectedAddress.kind !== 'session' ? event.windowId : null;
    else if (focusedDestinationWindowId === event.windowId) focusedDestinationWindowId = null;
    if (record?.chrome !== 'full' && record?.selectedAddress.kind === 'session') {
        const visibility = await import('@/sync/domains/session/sessionSurfaceVisibility');
        if (event.focused) visibility.setFocusedSessionId(record.selectedAddress.sessionId, record.homeId);
        else visibility.clearFocusedSessionId(record.selectedAddress.sessionId, record.homeId);
    }
    if (previousDestinationFocus !== focusedDestinationWindowId || (record && wasFocused !== focused(record))) {
        for (const subscriber of subscribers) subscriber();
    }
}

function ensureLifecycle(): Promise<() => void> {
    return lifecycle ??= Promise.all([
        listenDesktopHostEvent<LifecycleEvent>('desktopAppWindow://lifecycle', event => {
            fireAndForget(onLifecycle(event), { tag: 'appWindow.lifecycle', onError: workspace?.onRestoreError });
        }),
        listenDesktopHostEvent<readonly AppWindowRecord[]>('desktopAppWindow://records', snapshot => {
            adoptRecords(snapshot);
        }),
    ]).then(dispose => () => { for (const release of dispose) release(); });
}

/** The mounted workspace retains placement authority; native records contain only restore addresses. */
export function registerDesktopAppWindowWorkspace(owner: WorkspaceOwner): () => void {
    workspace = owner;
    initialization = (async () => {
        if ((await getDesktopHostAvailability()).windows.kind !== 'available' || workspace !== owner) return;
        await ensureLifecycle();
        if (workspace !== owner) return;
        const contexts = getDesktopHostWindowLabel() === 'main'
            ? await TokenStorage.listHomeCredentialContexts() : [owner.scope];
        const snapshot = await invokeDesktopHost<readonly AppWindowRecord[]>('desktop_app_window_restore', {
            contexts, activeOnly: true,
        });
        if (workspace !== owner) return;
        adoptRecords(snapshot);
        if (getDesktopHostWindowLabel() !== 'main') return;
        const retained = await invokeDesktopHost<readonly AppWindowRecord[]>('desktop_app_window_restore', { contexts });
        for (const record of retained) {
            if (workspace !== owner) return;
            if (records.has(record.windowId)) continue;
            const restore = (record: AppWindowRecord) => {
                if (workspace !== owner) return;
                const retry = async () => {
                    if (workspace !== owner) return;
                    try {
                        const contexts = await TokenStorage.listHomeCredentialContexts();
                        const retained = await invokeDesktopHost<readonly AppWindowRecord[]>('desktop_app_window_restore', { contexts });
                        const current = retained.find(saved => saved.windowId === record.windowId);
                        if (workspace === owner && current) restore(current);
                    } catch (error) { owner.onRestoreError?.(error, retry); }
                };
                const operation = beginOperation(record);
                fireAndForget((async () => {
                try {
                    if (record.chrome !== 'full' && record.selectedAddress.kind === 'session') {
                        const { prepareSessionDraftWindowTransfer } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
                        await prepareSessionDraftWindowTransfer({ serverId: record.homeId, accountId: record.accountId,
                            sessionId: record.selectedAddress.sessionId });
                    }
                    if (record.sourceTabId) transfer(record.sourceTabId, true);
                    if (record.selectedAddress.kind === 'paneTab') owner.panes?.setPresentation({ ...record.selectedAddress,
                        serverId: record.homeId, accountId: record.accountId }, record.windowId);
                    const placement = await invokeDesktopHost<{ workArea: WindowRect | null; previousFrame: WindowRect | null; frame: WindowRect | null }>(
                        'desktop_app_window_placement', { windowId: record.windowId });
                    const frame = placement.frame ?? (record.chrome !== 'full' && placement.workArea ? resolveWindowPlacement({ size: { width: 480, height: 640 },
                        workArea: placement.workArea, previousFrame: placement.previousFrame, ...owner.placementMetrics }) : undefined);
                    const opened = await invokeDesktopHost<OpenResult>('desktop_app_window_open', { record, ...(frame ? { frame } : {}) });
                    if (!opened.ready) await operation.ready;
                    records.set(record.windowId, record);
                    if (record.sourceTabId && record.sourceLayoutId === (owner.layoutId ?? owner.windowId)
                        && record.homeId === owner.scope.serverId && record.accountId === owner.scope.accountId) {
                        owner.dispatch({ type: 'setPresentation', tabId: record.sourceTabId, presentation: { windowId: record.windowId } });
                    }
                    publishRecords();
                } catch (error) {
                    await invokeDesktopHost('desktop_app_window_close', { windowId: record.windowId, reason: 'restoreFailed' });
                    clearPlacement(record.windowId);
                    throw error;
                } finally {
                    finishOperation(operation);
                    if (record.sourceTabId) transfer(record.sourceTabId, false);
                }
                })(), { tag: 'appWindow.restore', onError: error => owner.onRestoreError?.(error, retry) });
            };
            restore(record);
        }
    })();
    fireAndForget(initialization, { tag: 'appWindow.initialize', onError: owner.onRestoreError });
    return () => {
        if (workspace !== owner) return;
        workspace = null;
        const subscription = lifecycle;
        lifecycle = null;
        void subscription?.then(dispose => dispose());
    };
}

/** Called by the destination after its draft, mounted Action owners and loading UI commit. */
export async function readyDesktopAppWindow(_record: AppWindowRecord): Promise<void> {
    await invokeDesktopHost('desktop_app_window_ready');
}

/** A hidden recipient reports failure through its native caller identity, without revealing stale content. */
export async function failDesktopAppWindow(_record: AppWindowRecord | undefined, failure: 'metadata_unavailable' | 'presentation_unavailable'): Promise<void> {
    await invokeDesktopHost('desktop_app_window_ready', { failure });
}

function unsupported(): Error & { code: string } {
    return Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
}

/** One window lifecycle entry, reached by desktop.windows.open and session.open's adapter. */
export async function openDesktopAppWindow(input: DesktopWindowsOpenInput): Promise<DesktopWindowsOpenResult> {
    return openWindow(input);
}

type PaneWindowTarget = Extract<DesktopWindowsOpenInput['target'], { kind: 'paneTab' }>;

/** The current body admits departure before its source commits another slot selection. */
export async function retargetDesktopPaneWindow(address: PaneTabAddress,
    commitSelection: () => PaneWindowTarget | null): Promise<boolean> {
    await initialization;
    const record = paneWindow(address);
    if (!record) return false;
    return (await openWindow({ windowId: record.windowId, target: address }, commitSelection)).status !== 'cancelled';
}

async function openWindow(input: DesktopWindowsOpenInput,
    commitPaneSelection?: () => PaneWindowTarget | null): Promise<DesktopWindowsOpenResult> {
    if ((await getDesktopHostAvailability()).windows.kind !== 'available') throw unsupported();
    await initialization;
    const owner = workspace;
    if (!owner || !owner.windowId) throw unsupported();
    const target = input.target;
    const paneAddress: PaneTabAddress | null = target.kind === 'paneTab' ? { kind: 'paneTab', layoutId: target.layoutId,
        scopeId: target.scopeId, tabKey: target.tabKey, serverId: target.serverId, accountId: target.accountId } : null;
    const retainedPaneWindow = paneAddress ? paneWindow(paneAddress) : undefined;
    const paneTarget = paneAddress ? owner.panes?.resolveTarget(paneAddress)
        ?? (retainedPaneWindow?.selectedAddress.kind === 'paneTab' ? retainedPaneWindow.selectedAddress : null) : null;
    if (paneAddress && !paneTarget) throw unsupported();
    const tabs = Object.values(owner.getState().tabs);
    const addressedLayout = target.kind === 'workspaceTab' && target.layoutId
        ? sourceLayouts().find(layout => layout.serverId === target.serverId && layout.accountId === target.accountId && layout.layoutId === target.layoutId) : undefined;
    const hrefDestination = target.kind === 'destination' ? resolveDestinationRefFromHref(owner.catalog, target.href) : null;
    const tab = input.chrome === 'full' ? undefined : target.kind === 'workspaceTab' ? addressedLayout?.state.tabs[target.tabId] ?? tabs.find(tab => tab.id === target.tabId)
        : target.kind === 'session' ? tabs.find(tab => {
            const session = sessionForTab(tab, owner);
            return session?.sessionId === target.sessionId && session.serverId === target.serverId && session.accountId === target.accountId;
        }) : hrefDestination ? tabs.find(tab => sameDestinationRef(tab.target, hrefDestination)) : undefined;
    if (target.kind === 'workspaceTab' && (!tab || ((owner.scope.accountId !== target.accountId || owner.scope.serverId !== target.serverId
        || (target.layoutId && target.layoutId !== (owner.layoutId ?? owner.windowId))) && !placedWindow(target)))) throw unsupported();
    const scope = { serverId: target.serverId, accountId: target.accountId };
    const destination = tab?.target ?? (target.kind === 'session' ? { kind: 'session', params: {
        id: target.sessionId, ...scope,
    } } : hrefDestination);
    if (!destination && !paneTarget && !(input.chrome === 'full' && target.kind === 'home')) throw unsupported();
    const session = tab ? sessionForTab(tab, { scope }) : target.kind === 'session' ? target
        : destination ? desktopSessionTargetForDestination(destination, scope) : null;
    await ensureLifecycle();
    const sameTarget = (record: AppWindowRecord) => record.chrome === input.chrome && (paneAddress
        ? record.homeId === paneAddress.serverId && record.accountId === paneAddress.accountId
            && record.selectedAddress.kind === 'paneTab' && record.selectedAddress.layoutId === paneAddress.layoutId
            && record.selectedAddress.scopeId === paneAddress.scopeId && record.selectedAddress.tabKey === paneAddress.tabKey
            && record.selectedAddress.resourceId === paneTarget?.resourceId
        : target.kind === 'home' ? record.homeId === scope.serverId && record.accountId === scope.accountId && record.selectedAddress.kind === 'home'
        : Boolean(destination && sameWindowDestination(record, destination, scope)));
    const ownedWindowId = input.chrome === 'full' ? undefined : [...operations.values()].find(operation => sameTarget(operation.record))?.record.windowId
        ?? [...records.values()].find(sameTarget)?.windowId;
    const windowId = ownedWindowId ?? input.windowId ?? retainedPaneWindow?.windowId ?? tab?.presentation?.windowId ?? randomUUID();
    const pending = operations.get(windowId);
    if (pending) { await pending.done; return openWindow({ ...input, windowId }, commitPaneSelection); }
    const previous = records.get(windowId);
    if (previous && previous.chrome !== input.chrome) throw unsupported();
    const existingTarget = previous ? sameTarget(previous) && !commitPaneSelection : false;
    let record: AppWindowRecord = { windowId, accountId: scope.accountId, homeId: scope.serverId,
        layoutId: previous?.layoutId ?? windowId,
        ...(input.chrome === 'full' ? { chrome: 'full' as const } : {}),
        ...(tab && !existingTarget ? { sourceLayoutId: owner.layoutId ?? owner.windowId, sourceTabId: tab.id }
            : previous?.sourceLayoutId ? { sourceLayoutId: previous.sourceLayoutId, sourceTabId: previous.sourceTabId } : {}),
        selectedAddress: target.kind === 'home' ? { kind: 'home' } : paneTarget ?? (session ? { kind: 'session', sessionId: session.sessionId,
            ...('destination' in target && target.destination ? { destination: target.destination } : {}) }
            : tab ? { kind: 'workspaceTab', tabId: tab.id } : { kind: 'destination', target: destination! }) };
    let admitted = existingTarget || Boolean(commitPaneSelection && previous) || (!tab && !paneAddress) || Boolean(tab?.presentation);
    if (tab && !admitted) admitted = await prepareMountedTabPresentationTransfer(tab.id);
    if (paneAddress && !admitted) admitted = await owner.panes?.prepare(paneAddress) ?? false;
    if (!admitted) return { status: 'cancelled' };
    const operation = beginOperation(record);
    let released = false;
    let paneReleased = false;
    try {
        if (previous && (commitPaneSelection || previous.homeId !== record.homeId || previous.accountId !== record.accountId
            || JSON.stringify(previous.selectedAddress) !== JSON.stringify(record.selectedAddress))) {
            const bridge = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
            released = getDesktopHostWindowLabel() === `destination_${windowId}`
                ? await bridge.prepareDesktopAppWindowReturn() : await bridge.requestDesktopAppWindowReturn(`destination_${windowId}`);
            if (!released) return { status: 'cancelled' };
        }
        if (commitPaneSelection) {
            const selected = commitPaneSelection();
            if (!selected) {
                const { requestDesktopAppWindowResume } = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
                await requestDesktopAppWindowResume(`destination_${windowId}`);
                return { status: 'cancelled' };
            }
            record = { ...record, homeId: selected.serverId, accountId: selected.accountId, selectedAddress: {
                kind: 'paneTab', layoutId: selected.layoutId, scopeId: selected.scopeId, tabKey: selected.tabKey,
                ...(selected.resourceId ? { resourceId: selected.resourceId } : {}),
            } };
        }
        if (tab && !existingTarget && !tab.presentation && getDesktopHostWindowLabel() !== `destination_${windowId}`) {
            // Persist through the same layout owner before its body releases. A
            // failed durable write must leave the source editable.
            workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...owner.scope, windowId: owner.layoutId ?? owner.windowId }),
                serializeWorkspaceLayout(owner.getState()));
            if (session) {
                const { prepareSessionDraftWindowTransfer } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
                await prepareSessionDraftWindowTransfer(session);
            }
            transfer(tab.id, true);
        }
        if (paneAddress && !existingTarget) {
            // The existing pane record remains the membership/placement owner.
            // Its body releases before another realm restores the persisted tab.
            flushSync(() => owner.panes?.setPresentation(paneAddress, windowId));
            paneReleased = true;
        }
        const placement = await invokeDesktopHost<{ workArea: WindowRect | null; previousFrame: WindowRect | null; frame: WindowRect | null }>(
            'desktop_app_window_placement', { windowId });
        const frame = placement.frame ?? (input.chrome !== 'full' && placement.workArea ? resolveWindowPlacement({ size: { width: 480, height: 640 },
            workArea: placement.workArea, previousFrame: placement.previousFrame, ...owner.placementMetrics }) : undefined);
        records.set(windowId, record);
        const opened = await invokeDesktopHost<OpenResult>('desktop_app_window_open', { record, ...(frame ? { frame } : {}) });
        if (!opened.ready) await operation.ready;
        if (tab && !existingTarget) owner.dispatch({ type: 'setPresentation', tabId: tab.id, presentation: { windowId } });
        publishRecords();
        return { status: opened.reused ? 'focused' : 'opened', windowId, ...(frame ? { rect: frame } : {}) };
    } catch (error) {
        if (paneReleased && paneAddress) owner.panes?.setPresentation(paneAddress,
            previous?.selectedAddress.kind === 'paneTab' ? previous.windowId : null);
        if (previous) {
            records.set(windowId, previous);
            await invokeDesktopHost('desktop_app_window_update', { record: previous });
            if (released) {
                const { requestDesktopAppWindowResume } = await import('@/sync/ops/actions/desktopAppWindowActionDispatch');
                await requestDesktopAppWindowResume(`destination_${windowId}`);
            }
        } else {
            await invokeDesktopHost('desktop_app_window_close', { windowId });
            records.delete(windowId);
        }
        if (session && tab && !tab.presentation) {
            const { resumeSessionDraftWindowPresentation } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
            const release = await resumeSessionDraftWindowPresentation(session); release();
        }
        throw error;
    } finally {
        finishOperation(operation);
        if (tab) transfer(tab.id, false);
    }
}

function recordInput(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type AddressedWindowAction = Readonly<{ actionId?: ActionId; input: unknown; serverId: string; accountId: string; defaultSessionId?: string | null }>;

function sessionForAction(input: AddressedWindowAction): ExactSessionMachineTargetIdentity | null {
    const data = recordInput(input.input);
    // Action admission has already parsed the canonical composer reference. An
    // explicit non-Session composer must not inherit the caller's Session.
    const composer = data.ref !== undefined ? recordInput(data.ref)
        : data.composerRef !== undefined ? recordInput(data.composerRef) : null;
    const session = recordInput(data.session);
    const scope = recordInput(data.scope);
    const sessionId = session.sessionId ?? data.sessionId ?? (composer ? composer.sessionId : input.defaultSessionId);
    if (typeof sessionId !== 'string') return null;
    const serverId = typeof session.serverId === 'string' ? session.serverId : typeof scope.serverId === 'string' ? scope.serverId : input.serverId;
    const accountId = typeof session.accountId === 'string' ? session.accountId : typeof scope.accountId === 'string' ? scope.accountId : input.accountId;
    return { sessionId, serverId, accountId };
}

/** An admitted edit waits for the same move/return operation that releases its writer. */
export async function waitForDesktopAppWindowPresentation(input: AddressedWindowAction): Promise<void> {
    await initialization;
    const session = sessionForAction(input);
    if (!session) return;
    const pending = [...operations.values()].filter(({ record }) => record.chrome !== 'full' && record.homeId === session.serverId && record.accountId === session.accountId
        && record.selectedAddress.kind === 'session' && record.selectedAddress.sessionId === session.sessionId);
    await Promise.all(pending.map(operation => operation.done));
}

/** Placement decides writes once; native restore addresses project no-source windows. */
export function resolveDesktopAppWindowForAction(input: AddressedWindowAction): `destination_${string}` | null {
    const focused = getFocusedDesktopAppWindowSurface();
    const data = recordInput(input.input);
    const scope = recordInput(data.scope);
    const composer = recordInput(data.ref ?? data.composerRef);
    const session = sessionForAction(input);
    // Project the same canonical address keys advertised by mounted owners. File
    // and plugin commands retain their opaque current-presentation command ids.
    const method = input.actionId === 'ui.current_context.read' ? currentUiContextReadClientRpcMethod()
        : (input.actionId === 'ui.current_context.command.invoke' || input.actionId === 'account.home_continuation.invoke')
            && typeof data.commandId === 'string' ? currentUiContextCommandClientRpcMethod(data.commandId)
        : input.actionId === 'session.work.get' && session ? mountedWorkReadClientRpcMethod('session.work.get', session.sessionId)
        : input.actionId === 'inbox.get' ? mountedWorkReadClientRpcMethod('inbox.get')
        : input.actionId && isWorkflowAuthoringActionId(input.actionId)
            && scope.serverId === input.serverId && scope.accountId === input.accountId
            ? workflowDraftClientRpcMethod({ scope: { serverId: input.serverId, accountId: input.accountId },
                ...(typeof data.draftId === 'string' ? { draftId: data.draftId } : {}) })
        : composer.kind === 'workflowAuthoring' && typeof composer.draftId === 'string'
            ? workflowDraftClientRpcMethod({ scope: { serverId: input.serverId, accountId: input.accountId }, draftId: composer.draftId })
        : session && (!input.actionId || getActionSpec(input.actionId).clientPresenter === 'session')
            ? sessionUiActionClientRpcMethod(session.sessionId) : null;
    if (method) {
        const candidates = getDesktopAppWindowMountedSurfaces().filter(surface => surface.homeId === input.serverId
            && surface.accountId === input.accountId && surface.methods?.includes(method));
        const owner = candidates.find(surface => surface.windowId === focused?.windowId) ?? (candidates.length === 1 ? candidates[0] : null);
        if (owner) return owner.windowId === 'main' ? null : `destination_${owner.windowId}`;
    }
    if (input.actionId && input.actionId !== 'ui.current_context.read' && getActionSpec(input.actionId).clientPresenter !== 'session') return null;
    if (input.actionId === 'ui.current_context.read' && focused?.homeId === input.serverId && focused.accountId === input.accountId) {
        return focused.windowId === 'main' ? null : `destination_${focused.windowId}`;
    }
    if (!session) return null;
    if (focused?.sessionId === session.sessionId && focused.homeId === session.serverId && focused.accountId === session.accountId) {
        return focused.windowId === 'main' ? null : `destination_${focused.windowId}`;
    }
    const record = [...records.values()].find(record => record.chrome !== 'full' && record.homeId === session.serverId && record.accountId === session.accountId
        && record.selectedAddress.kind === 'session' && record.selectedAddress.sessionId === session.sessionId);
    return record ? `destination_${record.windowId}` : null;
}

import type { PaneTabAddress } from '@happier-dev/protocol/actions';
import type { DesktopWindowTarget } from '@happier-dev/protocol/actions/actionSpecs';
import type { AppPaneContextValue } from './AppPaneContext';
import type { PaneScopeState } from './model/appPaneReducer';
import { mergePaneScopePresentationState, normalizePersistedPaneScopes } from './model/paneScopePersistence';
import { PersistedPaneScopeSchema } from './model/paneScopePersistenceSchema';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { readPaneScopeInstanceKey } from './paneScopeIdentity';
import { detailsTabNavigationKey } from './details/workspace/detailsTabLifetime';
import { prepareMountedTabClose, prepareMountedTabPresentationTransfer } from '@/utils/navigation/runGuardedNavigation';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serializeDetailsWorkspaceState } from './details/workspace/migrateLegacyDetailsWorkspaceState';
import { readDetailsTabRehydrationFallbackState } from './details/workspace/detailsWorkspaceTypes';
import { enumerateSelectedPaneSlots, findSelectedPaneSlot } from './model/selectedPaneDestination';
import { resolveDetailsPresentationTabKey } from './details/workspace/detailsWorkspaceSelectors';

export function resolvePaneTabWindowTarget(context: Pick<AppPaneContextValue, 'getReadState'>, address: PaneTabAddress): Extract<DesktopWindowTarget, { kind: 'paneTab' }> | null {
    const pane = context.getReadState().scopes[address.scopeId];
    const slot = pane && findSelectedPaneSlot(readPlacedPaneSelections(address.scopeId, pane), address.tabKey);
    if (slot) return { ...address, resourceId: slot.resourceId };
    const details = pane?.details;
    if (!details?.tabsByKey[address.tabKey]) return null;
    const serialized = serializeDetailsWorkspaceState(details);
    const fallback = readDetailsTabRehydrationFallbackState(details.tabState[address.tabKey]);
    const restoredTabKey = serialized.tabsByKey[address.tabKey] ? address.tabKey
        : fallback && serialized.tabsByKey[fallback.key] ? fallback.key : null;
    return restoredTabKey ? { ...address, ...(restoredTabKey !== address.tabKey ? { resourceId: restoredTabKey } : {}) } : null;
}

export function paneScopeIdsForWorkspaceTabs(context: AppPaneContextValue, tabIds: readonly string[]): readonly string[] {
    const ids = new Set(tabIds);
    return Object.keys(context.getReadState().scopes).filter(scopeId => {
        const instanceKey = readPaneScopeInstanceKey(scopeId);
        return instanceKey !== null && ids.has(instanceKey);
    });
}

export function readPersistedPaneWindowScope(scopeId: string): PaneScopeState | null {
    const persisted = paneUiState.readStrict(scopeId, value => PersistedPaneScopeSchema.parse(value));
    return persisted ? normalizePersistedPaneScopes({ [scopeId]: persisted }, true)[scopeId] ?? null : null;
}

/** Hidden source slots read the presenting realm's admitted selection at their next command. */
function readPlacedPaneSelections(scopeId: string, pane: PaneScopeState): PaneScopeState {
    if (!enumerateSelectedPaneSlots(pane).some(slot => slot.presentation)) return pane;
    return mergePaneScopePresentationState(pane, readPersistedPaneWindowScope(scopeId));
}

export function resolvePaneTabParentDestination(address: PaneTabAddress): DestinationRef | null {
    const session = parseSessionPaneScopeId(address.scopeId);
    if (session) return { kind: 'session', params: { id: session.sessionId, serverId: address.serverId, accountId: address.accountId } };
    const project = parseProjectPaneScopeId(address.scopeId);
    return project ? { kind: 'project', params: { id: project.workspaceRefId, serverId: address.serverId } } : null;
}

/** Read-only discovery from the canonical pane scopes; callers supply their actual layout membership. */
export function listPaneWindowTabs(context: AppPaneContextValue,
    scope: Pick<PaneTabAddress, 'serverId' | 'accountId' | 'layoutId'> & Readonly<{ scopeIds: readonly string[] }>) {
    const state = context.getReadState();
    return scope.scopeIds.flatMap(scopeId => {
        const pane = state.scopes[scopeId];
        if (!pane) return [];
        const home = parseSessionPaneScopeId(scopeId)?.address?.serverId ?? parseProjectPaneScopeId(scopeId)?.serverId;
        if (home && !areServerProfileIdentifiersEquivalent(home, scope.serverId)) return [];
        const detailsTabs = Object.values(pane.details.groupsById).flatMap(group => group.tabKeys.flatMap(tabKey => {
            const tab = pane.details.tabsByKey[tabKey];
            if (!tab) return [];
            const address: PaneTabAddress = { kind: 'paneTab', serverId: scope.serverId, accountId: scope.accountId,
                layoutId: scope.layoutId, scopeId, tabKey };
            return [{ kind: 'paneTab' as const, id: JSON.stringify(address), address, scopeId, tabKey, paneType: tab.kind,
                groupId: group.id, title: tab.title, pinned: tab.isPinned, preview: tab.isPreview,
                ...(tab.presentation ? { presentation: tab.presentation } : {}) }];
        }));
        const slotTabs = enumerateSelectedPaneSlots(readPlacedPaneSelections(scopeId, pane)).map(slot => {
            const address: PaneTabAddress = { kind: 'paneTab', serverId: scope.serverId, accountId: scope.accountId,
                layoutId: scope.layoutId, scopeId, tabKey: slot.tabKey };
            return { kind: 'paneTab' as const, id: JSON.stringify(address), address, scopeId, tabKey: slot.tabKey,
                paneType: slot.paneType, groupId: slot.slot, title: slot.destination.kind === 'builtin' ? slot.destination.id : slot.destination.destination.localId,
                pinned: true, preview: false, ...(slot.presentation ? { presentation: slot.presentation } : {}) };
        });
        return [...detailsTabs, ...slotTabs];
    });
}

export async function preparePaneTabWindowTransfer(context: AppPaneContextValue, address: PaneTabAddress): Promise<boolean> {
    const pane = context.getReadState().scopes[address.scopeId];
    if (!pane) return false;
    const tabKey = resolveDetailsPresentationTabKey(pane.details, address.tabKey);
    if (!pane.details.tabsByKey[tabKey] && !findSelectedPaneSlot(pane, address.tabKey)) return false;
    if (!await prepareMountedTabPresentationTransfer(detailsTabNavigationKey(address.scopeId, tabKey))) return false;
    return context.flushPersistence?.() ?? !context.persistenceFailed;
}

export function setPaneTabWindowPresentation(context: AppPaneContextValue, address: PaneTabAddress, windowId: string | null): string {
    let tabKey = address.tabKey;
    if (windowId === null) {
        const target = resolvePaneTabWindowTarget(context, address);
        const persisted = readPersistedPaneWindowScope(address.scopeId);
        if (persisted) context.dispatch({ type: 'restoreScope', scopeId: address.scopeId, scope: persisted });
        const scope = context.getReadState().scopes[address.scopeId];
        tabKey = scope && findSelectedPaneSlot(scope, address.tabKey) ? tabKey : target?.resourceId ?? tabKey;
    }
    const scope = context.getReadState().scopes[address.scopeId];
    const slot = scope && findSelectedPaneSlot(scope, tabKey);
    context.dispatch({ type: slot ? 'setSelectedPanePresentation' : 'setDetailsTabPresentation', scopeId: address.scopeId, tabKey,
        presentation: windowId ? { windowId } : null });
    return tabKey;
}

export function clearPaneTabWindowPresentations(context: AppPaneContextValue, windowId: string): void {
    for (const [scopeId, pane] of Object.entries(context.getReadState().scopes)) {
        if (!Object.values(pane.details.tabsByKey).some(tab => tab.presentation?.windowId === windowId)
            && !enumerateSelectedPaneSlots(pane).some(slot => slot.presentation?.windowId === windowId)) continue;
        const persisted = readPersistedPaneWindowScope(scopeId);
        if (persisted) context.dispatch({ type: 'restoreScope', scopeId, scope: persisted });
        for (const tab of Object.values(context.getReadState().scopes[scopeId].details.tabsByKey)) {
            if (tab.presentation?.windowId !== windowId) continue;
            context.dispatch({ type: 'setDetailsTabPresentation', scopeId, tabKey: tab.key, presentation: null });
        }
        for (const slot of enumerateSelectedPaneSlots(context.getReadState().scopes[scopeId])) {
            if (slot.presentation?.windowId !== windowId) continue;
            context.dispatch({ type: 'setSelectedPanePresentation', scopeId, tabKey: slot.tabKey, presentation: null });
        }
    }
}

export function activatePaneWindowTab(context: Pick<AppPaneContextValue, 'getReadState' | 'dispatch'>, address: PaneTabAddress): void {
    const scope = context.getReadState().scopes[address.scopeId];
    const slot = scope && findSelectedPaneSlot(scope, address.tabKey);
    if (slot && scope) {
        if (slot.slot === 'detailsOverlay') {
            const overlay = scope.details.overlay;
            if (overlay) context.dispatch({ type: 'openDetailsOverlay', scopeId: address.scopeId, destination: overlay.destination,
                ...(overlay.instanceKey === undefined ? {} : { instanceKey: overlay.instanceKey }) });
        } else {
            context.dispatch({ type: slot.slot === 'right' ? 'openRight' : 'openBottom', scopeId: address.scopeId });
        }
        return;
    }
    context.dispatch({ type: 'setActiveDetailsTab', scopeId: address.scopeId, tabKey: address.tabKey });
}

export async function closePaneWindowTab(context: AppPaneContextValue, address: PaneTabAddress,
    options?: Readonly<{ prepared: true }>): Promise<boolean> {
    if (!options?.prepared && !await preparePaneTabWindowClose(context, address)) return false;
    const scope = context.getReadState().scopes[address.scopeId];
    const slot = scope && findSelectedPaneSlot(scope, address.tabKey);
    if (slot) {
        context.dispatch({ type: slot.slot === 'right' ? 'closeRight' : slot.slot === 'bottom' ? 'closeBottom' : 'closeDetailsOverlay', scopeId: address.scopeId });
        return true;
    }
    const tabKey = scope ? resolveDetailsPresentationTabKey(scope.details, address.tabKey) : address.tabKey;
    context.dispatch({ type: 'closeDetailsTab', scopeId: address.scopeId, tabKey });
    return !context.getReadState().scopes[address.scopeId]?.details.tabsByKey[tabKey];
}

/** A group owns its hidden placed members until each mounted window accepts Close. */
export async function closePaneDetailsWindowGroup(context: Pick<AppPaneContextValue, 'getReadState' | 'dispatch'>,
    scope: Pick<PaneTabAddress, 'serverId' | 'accountId' | 'layoutId' | 'scopeId'>, groupId: string): Promise<boolean> {
    const details = context.getReadState().scopes[scope.scopeId]?.details;
    const group = details?.groupsById[groupId];
    if (!group) return false;
    const { closeDesktopAppWindowTab } = await import('@/desktop/window/appWindowRuntime');
    for (const tabKey of group.tabKeys) {
        if (!details.tabsByKey[tabKey]?.presentation) continue;
        if (!await closeDesktopAppWindowTab({ kind: 'paneTab', ...scope, tabKey })) return false;
    }
    context.dispatch({ type: 'closeDetailsGroup', scopeId: scope.scopeId, groupId });
    return true;
}

export async function preparePaneTabWindowClose(context: AppPaneContextValue, address: PaneTabAddress): Promise<boolean> {
    const pane = context.getReadState().scopes[address.scopeId];
    const tabKey = pane ? resolveDetailsPresentationTabKey(pane.details, address.tabKey) : address.tabKey;
    if (!await prepareMountedTabClose(detailsTabNavigationKey(address.scopeId, tabKey))) return false;
    return context.flushPersistence?.() ?? !context.persistenceFailed;
}

export async function movePaneWindowTab(context: AppPaneContextValue, address: PaneTabAddress, targetGroupId: string,
    beforeMove?: () => Promise<boolean>): Promise<boolean> {
    const details = context.getReadState().scopes[address.scopeId]?.details;
    if (!details?.tabsByKey[address.tabKey] || !details.groupsById[targetGroupId]) return false;
    if (beforeMove && !await beforeMove()) return false;
    const tabKey = setPaneTabWindowPresentation(context, address, null);
    context.dispatch({ type: 'moveDetailsTabToGroup', scopeId: address.scopeId, tabKey, targetGroupId });
    return true;
}

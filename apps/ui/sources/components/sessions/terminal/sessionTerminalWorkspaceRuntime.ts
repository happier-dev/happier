import type { AppPaneAction, AppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { EMPTY_TERMINAL_WORKSPACE, readSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from './sessionTerminalWorkspace';
import { openSessionTerminalInDetails } from './embeddedTerminalDocking';
import type { SessionTerminalPendingActionApprovalV1 } from '@happier-dev/protocol/terminal/workspace';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createEmptyTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';
import { forgetTerminalSurfaceSummary } from './terminalSurfaceSummary';
import { isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';

type Owner = Readonly<{ getState: () => AppPaneState; getReadState?: () => AppPaneState; dispatch: (action: AppPaneAction) => void }>;
let mountedOwner: Owner | null = null;
const listeners = new Set<() => void>();
export function registerSessionTerminalWorkspaceOwner(owner: Owner): () => void {
    mountedOwner = owner;
    notifySessionTerminalWorkspaceChanged();
    return () => {
        if (mountedOwner !== owner) return;
        mountedOwner = null;
        notifySessionTerminalWorkspaceChanged();
    };
}
export function notifySessionTerminalWorkspaceChanged(): void {
    for (const listener of listeners) listener();
}
export function subscribeSessionTerminalWorkspace(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function readSessionTerminalWorkspaceForScope(scopeId: string, initialWorkspace?: import('@happier-dev/protocol').SessionTerminalWorkspaceV1) {
    const scope = (mountedOwner?.getReadState?.() ?? mountedOwner?.getState())?.scopes[scopeId];
    return mountedOwner && (scope || initialWorkspace) ? readSessionTerminalWorkspace(scope?.bottom.tabState.terminal ?? initialWorkspace) : null;
}
/** Explicit open intent initializes a new host through the existing pane owner; never on mount. */
export function initializeSessionTerminalWorkspaceForScope(scopeId: string, workspace: import('@happier-dev/protocol').SessionTerminalWorkspaceV1): boolean {
    if (!mountedOwner) return false;
    const project = parseProjectPaneScopeId(scopeId) ? resolveProjectTerminalScope(scopeId) : null;
    if (parseProjectPaneScopeId(scopeId) && !project) return false;
    const current = mountedOwner.getState().scopes[scopeId]?.bottom.tabState.terminal;
    if (current !== undefined && (!project || areServerAccountScopesEqual(readSessionTerminalWorkspace(current).ownerScope, project.scope))) return true;
    mountedOwner.dispatch({ type: 'setBottomTabState', scopeId, tabId: 'terminal',
        nextState: project ? { ...workspace, ownerScope: project.scope } : workspace });
    return true;
}
export function dispatchSessionTerminalWorkspaceCommand(scopeId: string, command: SessionTerminalWorkspaceCommand): boolean {
    if (!mountedOwner) return false;
    mountedOwner.dispatch({ type: 'terminalWorkspace', scopeId, command });
    return true;
}

/** Retire private Project presentation, including hidden panes; never stop the daemon process. */
export function retireProjectTerminalPresentationForHome(serverId: string, previousScope?: ServerAccountScope, onlyScopeId?: string): void {
    const owner = mountedOwner;
    if (!owner) return;
    for (const [scopeId, pane] of Object.entries(owner.getState().scopes)) {
        if (onlyScopeId !== undefined && scopeId !== onlyScopeId) continue;
        const identity = parseProjectPaneScopeId(scopeId);
        if (!identity || !areServerProfileIdentifiersEquivalent(identity.serverId, serverId)) continue;
        const workspace = readSessionTerminalWorkspace(pane.bottom.tabState.terminal);
        if (previousScope) for (const tab of workspace.tabs) for (const member of tab.terminals) {
            if (member.target.kind !== 'workspace_shell' || !member.target.workspace) continue;
            const key = buildProjectTerminalKey(previousScope, member.target.workspace, member.id);
            replaceTerminalSurfaceState(key, createEmptyTerminalSurfaceState());
            forgetTerminalSurfaceSummary(key);
        }
        owner.dispatch({ type: 'setBottomTabState', scopeId, tabId: 'terminal', nextState: EMPTY_TERMINAL_WORKSPACE });
        for (const tab of Object.values(pane.details.tabsByKey)) {
            if (isTerminalDetailsTab({ resource: tab.resource, tabKey: tab.key })) {
                owner.dispatch({ type: 'closeDetailsTab', scopeId, tabKey: tab.key });
            }
        }
    }
}
export function setSessionTerminalPendingActionApproval(scopeId: string, terminalId: string,
    pending: SessionTerminalPendingActionApprovalV1 | null, expectedArtifactId?: string): boolean {
    const workspace = readSessionTerminalWorkspaceForScope(scopeId,
        parseSessionPaneScopeId(scopeId) ? readSessionTerminalWorkspace(undefined) : undefined);
    if (!workspace?.tabs.some(tab => tab.terminals.some(member => member.id === terminalId))) return false;
    return dispatchSessionTerminalWorkspaceCommand(scopeId, { type: 'pendingActionApproval', terminalId, pending,
        ...(expectedArtifactId !== undefined ? { expectedArtifactId } : {}) });
}

export function openSessionTerminalInDetailsForScope(scopeId: string, terminalId: string): boolean {
    const owner = mountedOwner;
    if (!owner) return false;
    openSessionTerminalInDetails({
        openDetailsTab: (tab, options) => owner.dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: options?.intent === 'pinned' ? 'pinned' : 'preview' }),
        closeBottom: () => owner.dispatch({ type: 'closeBottom', scopeId }),
    }, terminalId);
    return true;
}

export type SessionTerminalSplitMeasurements = Readonly<{ availableWidthPx: number; minimumTerminalWidthPx: number }>;
// Mounted view measurements, not another layout store. The split engine remains the admission owner.
type Geometry = Readonly<{
    read: (tabId?: string) => SessionTerminalSplitMeasurements | null;
    resize?: (tabId: string, splitId: string, ratio: number) => boolean;
}>;
const measurementReaders = new Map<string, Geometry>();
export function registerSessionTerminalSplitMeasurements(scopeId: string, read: Geometry['read'], resize?: Geometry['resize']): () => void {
    const geometry = { read, resize };
    measurementReaders.set(scopeId, geometry);
    return () => { if (measurementReaders.get(scopeId) === geometry) measurementReaders.delete(scopeId); };
}
export function getSplitMeasurementsForScope(scopeId: string, tabId?: string): SessionTerminalSplitMeasurements | null {
    return measurementReaders.get(scopeId)?.read(tabId) ?? null;
}
export function resizeSessionTerminalSplitForScope(scopeId: string, tabId: string, splitId: string, ratio: number): boolean | null {
    return measurementReaders.get(scopeId)?.resize?.(tabId, splitId, ratio) ?? null;
}

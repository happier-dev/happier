import type { AppPaneAction, AppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { readSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from './sessionTerminalWorkspace';
import { openSessionTerminalInDetails } from './embeddedTerminalDocking';

type Owner = Readonly<{ getState: () => AppPaneState; dispatch: (action: AppPaneAction) => void }>;
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
export function readSessionTerminalWorkspaceForScope(scopeId: string) {
    const scope = mountedOwner?.getState().scopes[scopeId];
    return scope ? readSessionTerminalWorkspace(scope.bottom.tabState.terminal) : null;
}
export function dispatchSessionTerminalWorkspaceCommand(scopeId: string, command: SessionTerminalWorkspaceCommand): boolean {
    if (!mountedOwner) return false;
    mountedOwner.dispatch({ type: 'terminalWorkspace', scopeId, command });
    return true;
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

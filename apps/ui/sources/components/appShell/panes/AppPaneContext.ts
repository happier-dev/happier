import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { PaneDriver, PaneScopeId } from './types';
import { readResourcePaneScopeId } from './paneScopeIdentity';
import type { AppPaneAction, AppPaneState } from './model/appPaneReducer';
import type { PaneOverlayFocusReturnOwner } from './paneOverlayFocusReturn';
import type { FileFindSeedHandoff } from './fileFindSeedHandoff';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { workspaceFileDetailsTabKey } from './details/fileDetailsTab';

export type AppPaneContextValue = Readonly<{
    state: AppPaneState;
    /** Command-time state, including earlier commands in the same React batch. */
    getReadState: () => AppPaneState;
    /** Pane state remains in memory if the device could not persist its latest write. */
    persistenceFailed?: boolean;
    dispatch: (action: AppPaneAction) => void;
    registerDriver: (driver: PaneDriver) => () => void;
    getDriver: (scopeId: PaneScopeId) => PaneDriver | null;
    driverRegistryVersion: number;
    overlayFocusReturnOwner: PaneOverlayFocusReturnOwner;
    fileFindSeedHandoff: FileFindSeedHandoff;
    fileFindSeedAccountBindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>;
}>;

export type AppPaneContextSubscription = Readonly<{
    getSnapshot: () => AppPaneContextValue;
    subscribe: (listener: () => void) => () => void;
}>;

export const AppPaneContext = createContext<AppPaneContextSubscription | null>(null);
export type AppPaneFindSeedContextValue = Pick<AppPaneContextValue, 'fileFindSeedHandoff' | 'fileFindSeedAccountBindings'>;
// Launch consumers need credential/handoff changes, not every pane reducer tick.
export const AppPaneFindSeedContext = createContext<AppPaneFindSeedContextValue | null>(null);
// File origins need the stable transient focus owner, rather than every pane-state update.
export const AppPaneFocusReturnContext = createContext<PaneOverlayFocusReturnOwner | null>(null);
// Command-time driver lookup is stable; it must not subscribe the workspace to pane edits.
export const AppPaneDriverContext = createContext<AppPaneContextValue['getDriver'] | null>(null);

type FileTabFrontSubscription = Readonly<{
    subscribe: (listener: () => void) => () => void;
    read: (scopeId: string, path: string, rootPath?: string) => boolean;
    /**
     * Whether the active pane scope is this resource's (any window instance of it) and its Details pane is
     * open; a phone presents that Details as the full page.
     */
    readActiveDetailsOpen: (resourceScopeId: string) => boolean;
}>;

export const AppPaneFileFrontContext = createContext<FileTabFrontSubscription | null>(null);

/** A read-only projection of the provider's current state, never another state owner. */
export function createFileTabFrontSubscription(readState: () => AppPaneState): FileTabFrontSubscription & Readonly<{ notify: () => void }> {
    const listeners = new Set<() => void>();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        read(scopeId, path, rootPath) {
            const details = readState().scopes[scopeId]?.details;
            return details?.isOpen === true && details.focusedGroupId !== null
                && details.groupsById[details.focusedGroupId]?.activeTabKey === workspaceFileDetailsTabKey(path, rootPath);
        },
        readActiveDetailsOpen(resourceScopeId) {
            const state = readState();
            const active = state.activeScopeId;
            return active !== null && readResourcePaneScopeId(active) === resourceScopeId
                && state.scopes[active]?.details.isOpen === true;
        },
        notify() {
            for (const listener of listeners) listener();
        },
    };
}

const readContext = (value: AppPaneContextValue) => value;
const subscribeToNothing = () => () => {};

function useSelectedAppPaneContext<T>(selector: (value: AppPaneContextValue) => T): T | null {
    const context = useContext(AppPaneContext);
    const select = useShallow((value: AppPaneContextValue | null) => value === null ? null : selector(value));
    const getSnapshot = useCallback(() => select(context?.getSnapshot() ?? null), [context, select]);
    return useSyncExternalStore(context?.subscribe ?? subscribeToNothing, getSnapshot, getSnapshot);
}

export function useAppPaneContext<T>(selector: (value: AppPaneContextValue) => T): T;
export function useAppPaneContext(): AppPaneContextValue;
export function useAppPaneContext<T>(selector?: (value: AppPaneContextValue) => T): AppPaneContextValue | T {
    const context = useContext(AppPaneContext);
    const selected = useSelectedAppPaneContext<AppPaneContextValue | T>(selector ?? readContext);
    if (!context) throw new Error('useAppPaneContext must be used within <AppPaneProvider>');
    // A mounted provider always invokes the selector, whose result may itself be null.
    return selected as AppPaneContextValue | T;
}

export function useOptionalAppPaneContext<T>(selector: (value: AppPaneContextValue) => T): T | null;
export function useOptionalAppPaneContext(): AppPaneContextValue | null;
export function useOptionalAppPaneContext<T>(selector?: (value: AppPaneContextValue) => T): AppPaneContextValue | T | null {
    return useSelectedAppPaneContext<AppPaneContextValue | T>(selector ?? readContext);
}

export function useOptionalAppPaneFindSeedContext(): AppPaneFindSeedContextValue | null {
    return useContext(AppPaneFindSeedContext);
}

export function useOptionalPaneFocusReturnOwner(): PaneOverlayFocusReturnOwner | null {
    return useContext(AppPaneFocusReturnContext);
}

export function useOptionalPaneDriverReader(): AppPaneContextValue['getDriver'] | null {
    return useContext(AppPaneDriverContext);
}

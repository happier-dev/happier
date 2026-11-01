import * as React from 'react';

import { AppPaneFileFrontContext } from '../AppPaneContext';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

const subscribeToNothing = () => () => {};

/** Chips observe only whether this exact file is at the front of its retained pane. */
export function useFileTabFront(scopeId: string, path: string, rootPath?: string): boolean {
    const projection = React.useContext(AppPaneFileFrontContext);
    const read = React.useCallback(() => projection?.read(scopeId, path, rootPath) ?? false, [projection, scopeId, path, rootPath]);
    return React.useSyncExternalStore(projection?.subscribe ?? subscribeToNothing, read, read);
}

/** Bottom chrome observes only whether the active page of this resource has Details open, not every pane edit. */
export function useActiveDetailsPaneOpen(resourceScopeId: string | null): boolean {
    const projection = React.useContext(AppPaneFileFrontContext);
    const read = React.useCallback(() => (resourceScopeId ? projection?.readActiveDetailsOpen(resourceScopeId) ?? false : false),
        [projection, resourceScopeId]);
    return React.useSyncExternalStore(projection?.subscribe ?? subscribeToNothing, read, read);
}

/**
 * A transcript chip's answer: is this file the front tab of the Session pane the opener would open it in?
 * The scope is derived exactly as `useWorkspaceFileOpener` derives it (Session + retained instance).
 */
export function useSessionFileTabFront(sessionId: string | null | undefined, serverId: string | null | undefined, path: string, rootPath?: string): boolean {
    const instance = React.useContext(DestinationInstanceContext);
    const scopeId = sessionId ? createSessionPaneScopeId(sessionId, serverId ?? undefined, instance?.tabId ?? null) : '';
    return useFileTabFront(scopeId, path, rootPath);
}

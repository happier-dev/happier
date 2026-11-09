import * as React from 'react';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectSurfaceController } from './useProjectSurfaceController';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

export function useProjectRouteSurfaceSync(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    isFocused: boolean;
    surface: ProjectMobileSurface;
}>) {
    const dispatch = useAppPaneContext(value => value.dispatch);
    const terminalPageActive = params.isFocused && params.surface === 'terminal';
    React.useLayoutEffect(() => {
        if (!terminalPageActive) return;
        dispatch({ type: 'setTerminalPageActive', scopeId: params.scopeId, active: true });
        return () => dispatch({ type: 'setTerminalPageActive', scopeId: params.scopeId, active: false });
    }, [dispatch, params.scopeId, terminalPageActive]);
    const { syncSurface, rightOpen, closeRetainedRightPaneOnPhone } = useProjectSurfaceController({
        scopeId: params.scopeId,
        workspaceRef: params.workspaceRef,
        activeRootPath: params.activeRootPath,
        activeWorktreeId: params.activeWorktreeId,
    });
    const routeSyncKey = `${params.workspaceRef.serverId}\u0000${params.workspaceRef.id}\u0000${params.activeRootPath}\u0000${params.activeWorktreeId ?? ''}\u0000${params.surface}`;
    const lastSyncedRouteKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!params.isFocused) {
            lastSyncedRouteKeyRef.current = null;
            return;
        }
        if (lastSyncedRouteKeyRef.current === routeSyncKey) {
            return;
        }

        lastSyncedRouteKeyRef.current = routeSyncKey;
        syncSurface(params.surface);
    }, [params.isFocused, params.surface, routeSyncKey, syncSurface]);

    React.useEffect(() => {
        if (params.isFocused && rightOpen) closeRetainedRightPaneOnPhone();
    }, [params.isFocused, closeRetainedRightPaneOnPhone, rightOpen]);
}

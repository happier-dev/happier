import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { registerRepositoryUploadTarget, type RepositoryUploadTarget } from './repositoryUploadActionRuntime';

/** Mounted UI admission only; acquisition and transfer stay with the existing picker owner. */
export function useRepositoryUploadActionTarget(params: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    enabled: boolean;
    pick: (input: Parameters<RepositoryUploadTarget['pick']>[0], isCurrent: () => boolean) => ReturnType<RepositoryUploadTarget['pick']>;
}>) {
    const scope = useActiveServerAccountScope();
    const presentationActive = useLayoutPresentationActive();
    const latest = React.useRef({ ...params, scope, presentationActive });
    latest.current = { ...params, scope, presentationActive };
    const admissionRef = React.useRef<() => boolean>(() => false);
    const captureCurrentAcquisition = React.useCallback(() => admissionRef.current, []);
    const workspace = params.workspaceScope;
    React.useEffect(() => {
        if (!scope || !workspace || scope.serverId !== workspace.serverId) return;
        let registered = true;
        const isCurrent = () => {
            const current = latest.current;
            return registered && current.enabled && current.presentationActive && current.scope?.serverId === scope.serverId
                && current.scope.accountId === scope.accountId
                && current.workspaceScope?.serverId === workspace.serverId
                && current.workspaceScope.machineId === workspace.machineId
                && current.workspaceScope.rootPath === workspace.rootPath;
        };
        admissionRef.current = isCurrent;
        const unregister = registerRepositoryUploadTarget({
            scope,
            workspaceScope: workspace,
            isCurrent,
            pick: input => latest.current.pick(input, isCurrent),
        });
        return () => {
            registered = false;
            unregister();
        };
    }, [scope?.serverId, scope?.accountId, workspace?.serverId, workspace?.machineId, workspace?.rootPath]);
    return captureCurrentAcquisition;
}

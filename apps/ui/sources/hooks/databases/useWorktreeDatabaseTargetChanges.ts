import * as React from 'react';
import { isLocalServiceStateRunningV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    getLocalServiceLauncherState, subscribeLocalServiceLauncherStore,
    type LocalServiceLauncherStoreKeyInput,
} from '@/sync/domains/local/services/launch/sharedStore';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export const useWorktreeDatabaseTargetChanges: NonNullable<HostDatabaseWorkbench['useWorktreeTargetChanges']> = (scope, onChanged) => {
    const presented = useLayoutPresentationActive();
    const { binding } = useServerCredentialAccountScopeBinding(scope?.workspace.serverId);
    const accountId = scope?.accountId;
    const { machineId, rootPath, workspaceId } = scope?.workspace ?? {};
    // Remember the last observed membership across presentation changes.
    const observation = React.useMemo(() => ({ signature: '' }), [accountId, binding, machineId, rootPath, workspaceId]);
    React.useEffect(() => {
        if (!presented || !machineId || !rootPath || !workspaceId || !binding?.credentialKey
            || binding.accountId !== accountId || !binding.isCurrent()) return;
        const key: LocalServiceLauncherStoreKeyInput = {
            serverId: binding.serverId, machineId, accountId, credentialKey: binding.credentialKey,
            scope: 'workspace', workspaceRoot: rootPath, projection: 'managed_bindings',
        };
        const observe = () => {
            const state = getLocalServiceLauncherState(key);
            if (state.updatedAt === null || state.refreshStatus === 'error') return;
            const members: string[] = [];
            for (const target of state.targetsById.values()) {
                if (target.sourceClass?.kind === 'managed_service' && target.workspace?.workspaceId === workspaceId
                    && target.startedByAccountId === accountId && isLocalServiceStateRunningV1(target.serviceState)) {
                    members.push(target.sourceClass.managedServiceId);
                }
            }
            const signature = members.length ? JSON.stringify(members.sort()) : '';
            if (signature === observation.signature) return;
            observation.signature = signature;
            onChanged();
        };
        const release = subscribeLocalServiceLauncherStore(key, observe);
        const retirement = binding.onRetire(release);
        observe();
        return () => {
            retirement.dispose();
            release();
        };
    }, [accountId, binding, machineId, observation, onChanged, presented, rootPath, workspaceId]);
};

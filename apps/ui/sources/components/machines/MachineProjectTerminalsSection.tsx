import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { t } from '@/text';

/** Machine detail projects accepted requester checkouts; it never admits a directory itself. */
export function MachineProjectTerminalsSection(props: Readonly<{ machineId: string; serverId: string }>) {
    const refs = useWorkspaceRefs();
    const router = useRouter();
    const roots = refs.filter(ref => ref.machineId === props.machineId
        && areServerProfileIdentifiersEquivalent(ref.serverId, props.serverId));
    if (!roots.length) return null;
    return <ItemGroup title={t('settings.terminal')}>
        {roots.map(ref => <Item key={ref.id} testID={`machine-project-terminal-${ref.id}`}
            title={ref.label ?? ref.rootPath} subtitle={ref.rootPath} onPress={() => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                const admitted = resolveProjectTerminalScope(buildProjectPaneScopeId(ref.id, ref.serverId), {
                    serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath,
                });
                if (!lifetime?.isCurrent() || !admitted?.lifetime.isCurrent()) return;
                router.push(resolveProjectRoutePathForSurface({ workspaceRefId: admitted.workspace.workspaceId,
                    serverId: admitted.workspace.serverId, surface: 'terminal' }) as never);
            }} />)}
    </ItemGroup>;
}

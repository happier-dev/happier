import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
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
    // Terminals are records to browse: flat on the page, never a card (DESIGN "browse flat").
    return <ItemGroup surface="none" title={t('settings.terminal')}>
        {roots.map(ref => <Item key={ref.id} testID={`machine-project-terminal-${ref.id}`}
            title={resolveWorkspaceRefDisplayName(ref)} subtitle={ref.rootPath} onPress={() => {
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

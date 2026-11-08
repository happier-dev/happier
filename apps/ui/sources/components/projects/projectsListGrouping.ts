import { compareProjectWorkspaceRefsV1, projectProjectListV1, type ProjectListGroupV1, type ProjectListOrganizationV1 } from '@happier-dev/protocol/workspaces';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

type MachineGroup = Readonly<{
    machineId: string;
    items: readonly WorkspaceRefV1[];
}>;

export type ProjectsListGroups = Readonly<{
    pinned: readonly WorkspaceRefV1[];
    machineGroups: readonly MachineGroup[];
    /** The Projects the person added (owner 11-08). */
    projectGroups: readonly ProjectListGroupV1[];
    hiddenProjectGroups: readonly ProjectListGroupV1[];
    /** Folders only a Session brought, newest first: "From your sessions" in the + menu. */
    unlistedProjectGroups: readonly ProjectListGroupV1[];
}>;

export function buildProjectsListGroups(input: Readonly<{
    activeServerId: string;
    workspaceRefs: readonly WorkspaceRefV1[];
    pinnedWorkspaceRefIds: readonly string[];
    projectOrganizations?: readonly ProjectListOrganizationV1[];
}>): ProjectsListGroups {
    const projected = projectProjectListV1({ serverId: input.activeServerId, workspaceRefs: input.workspaceRefs,
        organizations: input.projectOrganizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier, listing: 'listed' });
    const visible = projected.items.map(item => item.ref);
    const pinnedIds = [...new Set(input.pinnedWorkspaceRefIds)];
    const pinnedSet = new Set(pinnedIds);
    const pinned = pinnedIds.flatMap(id => visible.filter(ref => ref.id === id).sort(compareProjectWorkspaceRefsV1));
    const machineIds = [...new Set(visible.filter(ref => !pinnedSet.has(ref.id)).map(ref => ref.machineId))].sort();
    return { pinned,
        machineGroups: machineIds.map(machineId => ({ machineId,
            items: visible.filter(ref => ref.machineId === machineId && !pinnedSet.has(ref.id)).sort(compareProjectWorkspaceRefsV1) })),
        projectGroups: projected.listedProjectGroups, hiddenProjectGroups: projected.hiddenProjectGroups,
        unlistedProjectGroups: projected.unlistedProjectGroups };
}

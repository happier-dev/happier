import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

type MachineGroup = Readonly<{
    machineId: string;
    items: readonly WorkspaceRefV1[];
}>;

export type ProjectsListGroups = Readonly<{
    pinned: readonly WorkspaceRefV1[];
    machineGroups: readonly MachineGroup[];
}>;

function sortWorkspaceRefsMostRecentFirst(items: readonly WorkspaceRefV1[]): WorkspaceRefV1[] {
    return [...items].sort((a, b) => {
        const aOpened = typeof a.lastOpenedAtMs === 'number' ? a.lastOpenedAtMs : -1;
        const bOpened = typeof b.lastOpenedAtMs === 'number' ? b.lastOpenedAtMs : -1;
        if (aOpened !== bOpened) return bOpened - aOpened;
        return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);
    });
}

export function buildProjectsListGroups(input: Readonly<{
    activeServerId: string;
    workspaceRefs: readonly WorkspaceRefV1[];
    pinnedWorkspaceRefIds: readonly string[];
}>): ProjectsListGroups {
    const activeServerId = String(input.activeServerId ?? '').trim();
    const refs = (input.workspaceRefs ?? []).filter((ref) => areServerProfileIdentifiersEquivalent(String(ref.serverId ?? '').trim(), activeServerId));

    const byId = new Map<string, WorkspaceRefV1>();
    for (const ref of refs) {
        const id = String(ref.id ?? '').trim();
        if (!id) continue;
        if (!byId.has(id)) {
            byId.set(id, ref);
        }
    }

    const pinned: WorkspaceRefV1[] = [];
    const pinnedIdSet = new Set<string>();
    for (const rawId of input.pinnedWorkspaceRefIds ?? []) {
        const id = String(rawId ?? '').trim();
        if (!id) continue;
        if (pinnedIdSet.has(id)) continue;
        pinnedIdSet.add(id);
        const ref = byId.get(id);
        if (ref) pinned.push(ref);
    }

    const unpinned: WorkspaceRefV1[] = [];
    for (const ref of refs) {
        const id = String(ref.id ?? '').trim();
        if (id && pinnedIdSet.has(id)) continue;
        unpinned.push(ref);
    }

    const groupsByMachineId = new Map<string, WorkspaceRefV1[]>();
    for (const ref of unpinned) {
        const machineId = String(ref.machineId ?? '').trim() || 'unknown';
        const current = groupsByMachineId.get(machineId);
        if (current) {
            current.push(ref);
        } else {
            groupsByMachineId.set(machineId, [ref]);
        }
    }

    const machineGroups: MachineGroup[] = [...groupsByMachineId.entries()]
        .filter(([machineId]) => machineId !== 'unknown')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([machineId, items]) => ({ machineId, items: sortWorkspaceRefsMostRecentFirst(items) }));

    return {
        pinned,
        machineGroups,
    };
}

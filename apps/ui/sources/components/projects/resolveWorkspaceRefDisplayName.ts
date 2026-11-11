import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

function projectWorkspaceDisplayFacts(workspaceRef: WorkspaceRefV1) {
    const { id, serverId, machineId, rootPath } = workspaceRef;
    const label = resolveWorkspaceDisplayLabel({
        scope: { serverId, machineId, rootPath },
        workspaceRef,
        fallbackPathLabel: resolveWorkspacePathBasenameV1(String(rootPath ?? '').trim()) ?? rootPath,
    });
    const path = rootPath.replace(/[\\/]+$/, '');
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    return { label, path, parentName: resolveWorkspacePathBasenameV1(parent),
        identity: JSON.stringify([id, serverId, machineId, rootPath]) };
}

function resolveWorkspaceDisplayNames(rows: readonly ReturnType<typeof projectWorkspaceDisplayFacts>[]): string[] {
    const groups = new Map<string, { identities: Set<string>; parents: Map<string | null, Set<string>> }>();
    for (const row of rows) {
        let group = groups.get(row.label);
        if (!group) {
            group = { identities: new Set(), parents: new Map() };
            groups.set(row.label, group);
        }
        group.identities.add(row.identity);
        let identities = group.parents.get(row.parentName);
        if (!identities) {
            identities = new Set();
            group.parents.set(row.parentName, identities);
        }
        identities.add(row.identity);
    }
    return rows.map(row => {
        const group = groups.get(row.label)!;
        if (group.identities.size === 1) return row.label;
        const place = row.parentName && group.parents.get(row.parentName)!.size === 1 ? row.parentName : row.path;
        return place ? `${row.label} · ${place}` : row.label;
    });
}

export function resolveWorkspaceRefDisplayName(workspaceRef: WorkspaceRefV1, siblings?: readonly WorkspaceRefV1[]): string {
    const row = projectWorkspaceDisplayFacts(workspaceRef);
    return siblings?.length
        ? resolveWorkspaceDisplayNames([row, ...siblings.map(projectWorkspaceDisplayFacts)])[0]!
        : row.label;
}

/** Display names for a set of workspaces shown together, each told apart from its same-named siblings. */
export function resolveWorkspaceRefDisplayNames(workspaceRefs: readonly WorkspaceRefV1[]): string[] {
    return resolveWorkspaceDisplayNames(workspaceRefs.map(projectWorkspaceDisplayFacts));
}

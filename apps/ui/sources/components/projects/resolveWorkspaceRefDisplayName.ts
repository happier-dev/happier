import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export function resolveWorkspaceRefDisplayName(workspaceRef: WorkspaceRefV1, siblings?: readonly WorkspaceRefV1[]): string {
    const label = resolveWorkspaceDisplayLabel({
        scope: {
            serverId: workspaceRef.serverId,
            machineId: workspaceRef.machineId,
            rootPath: workspaceRef.rootPath,
        },
        workspaceRef,
        fallbackPathLabel: resolveWorkspacePathBasenameV1(String(workspaceRef.rootPath ?? '').trim()) ?? workspaceRef.rootPath,
    });
    const sameNamedSiblings = siblings?.filter(ref => (ref.id !== workspaceRef.id || ref.serverId !== workspaceRef.serverId
        || ref.machineId !== workspaceRef.machineId || ref.rootPath !== workspaceRef.rootPath)
        && resolveWorkspaceRefDisplayName(ref) === label);
    if (!sameNamedSiblings?.length) return label;
    const path = workspaceRef.rootPath.replace(/[\\/]+$/, '');
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    const parentName = resolveWorkspacePathBasenameV1(parent);
    const sameParentName = sameNamedSiblings.some(ref => {
        const otherPath = ref.rootPath.replace(/[\\/]+$/, '');
        const otherParent = otherPath.slice(0, Math.max(otherPath.lastIndexOf('/'), otherPath.lastIndexOf('\\')));
        return resolveWorkspacePathBasenameV1(otherParent) === parentName;
    });
    const place = parentName && !sameParentName ? parentName : path;
    return place ? `${label} · ${place}` : label;
}

/** Display names for a set of workspaces shown together, each told apart from its same-named siblings. */
export function resolveWorkspaceRefDisplayNames(workspaceRefs: readonly WorkspaceRefV1[]): string[] {
    // Each name reads its siblings; never `.map(resolveWorkspaceRefDisplayName)`, which hands it the index.
    return workspaceRefs.map((workspaceRef) => resolveWorkspaceRefDisplayName(workspaceRef, workspaceRefs));
}

import type { EntityDragItemV1, EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveDestinationRefFromHref, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';

export function buildRepositoryFileDragItem(input: Readonly<{
    scope: EntityDragScopeV1;
    workspace: WorkspaceScopeBase;
    path: string;
    entryKind?: 'file' | 'directory';
}>): Extract<EntityDragItemV1, { kind: 'repository-file' }> {
    const { scope, workspace, path, entryKind } = input;
    return {
        kind: 'repository-file', scope, machineId: workspace.machineId, path,
        ...(entryKind ? { entryKind } : {}),
        ...(workspace.workspace ? { workspaceId: workspace.workspace.workspaceId } : {}),
    };
}

/** A destination's registered route owns its carried identity; the host supplies Account scope. */
export function resolveWorkspaceDestinationEntityItem(input: Readonly<{
    href: string | null;
    scope: EntityDragScopeV1;
    catalog: readonly CompactAppDestination[] | undefined;
    entityItem?: EntityDragItemV1 | null;
}>): EntityDragItemV1 | null {
    const { href, scope, entityItem } = input;
    const ref = href && input.catalog ? resolveDestinationRefFromHref(input.catalog, href) : null;
    if (ref?.params.serverId && ref.params.serverId !== scope.serverId) return null;
    if (ref?.params.accountId && ref.params.accountId !== scope.accountId) return null;
    if (entityItem) {
        if (entityItem.scope.serverId !== scope.serverId || entityItem.scope.accountId !== scope.accountId) return null;
        // Session files keep their catalog-qualified destination; Project files retain checkout identity.
        if (href && entityItem.kind === 'repository-file' && entityItem.entryKind !== 'directory' && !entityItem.workspaceId) {
            if (ref?.kind === 'project' && ref.params.workspaceRefId) return { ...entityItem, workspaceId: ref.params.workspaceRefId };
            return { kind: 'destination', scope, href };
        }
        return entityItem;
    }
    if (ref?.kind === 'session' && ref.params.id) return { kind: 'session', scope,
        address: { serverId: scope.serverId, sessionId: ref.params.id } };
    if (ref?.kind === 'workflow' && ref.params.id) return { kind: 'workflow', scope, workflowId: ref.params.id };
    return href ? { kind: 'destination', scope, href } : null;
}

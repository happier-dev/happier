import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { resolveWorkspaceSyncRelationshipEndpointRoles } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { resolveWorkspaceSyncStatusScope } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { t } from '@/text';
import type { WorkspaceSyncConflictDetailsResource } from './WorkspaceSyncConflictDetailsView';

export function createWorkspaceSyncConflictDetailsResource(
    summary: WorkspaceSyncRelationshipSummary,
    localWorkspaceRefId?: string | null,
): WorkspaceSyncConflictDetailsResource {
    const scope = resolveWorkspaceSyncStatusScope(summary);
    const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
        mode: summary.relationship.mode,
        controllerMachineId: summary.relationship.controllerMachineId,
        alphaMachineId: summary.alpha.workspaceRef?.machineId ?? '',
        betaMachineId: summary.beta.workspaceRef?.machineId ?? '',
    });
    const hubWorkspaceRefId = roles?.sourceEndpointRole === 'beta'
        ? summary.beta.workspaceRefId
        : summary.alpha.workspaceRefId;
    return {
            kind: 'workspaceSyncConflicts',
            hubWorkspaceRefId,
            workspaceRefId: localWorkspaceRefId ?? summary.alpha.workspaceRefId,
            controllerMachineId: scope.controllerMachineId,
            serverId: scope.serverId,
    };
}

export function createWorkspaceSyncConflictDetailsTab(
    summary: WorkspaceSyncRelationshipSummary,
    localWorkspaceRefId?: string | null,
): DetailsTab {
    const resource = createWorkspaceSyncConflictDetailsResource(summary, localWorkspaceRefId);
    return {
        key: `workspace-sync-conflicts:${resource.hubWorkspaceRefId}`,
        kind: 'workspaceSyncConflicts',
        title: t('workspaceSync.conflictsTitle'),
        resource,
    };
}

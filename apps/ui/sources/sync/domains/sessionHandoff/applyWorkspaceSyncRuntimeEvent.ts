import { WorkspaceSyncRuntimeEventV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { invalidateWorkspaceSyncConflicts } from './workspaceSyncConflictStore';
import { applyWorkspaceSyncEngineReadinessEvent } from './workspaceSyncEngineReadinessStore';
import { applyWorkspaceSyncStatusEvent, type WorkspaceSyncStatusScope } from './workspaceSyncStatusStore';

export function applyWorkspaceSyncRuntimeEvent(input: Readonly<{
    serverId: string | null;
    machineId: string;
    event: unknown;
}>): void {
    const parsed = WorkspaceSyncRuntimeEventV1Schema.safeParse(input.event);
    if (!parsed.success) return;
    applyWorkspaceSyncEngineReadinessEvent({
        serverId: input.serverId,
        machineId: input.machineId,
    }, parsed.data.readiness);
    const status = parsed.data.status;
    if (!status || status.controllerMachineId !== input.machineId) return;
    const scope: WorkspaceSyncStatusScope = {
        serverId: input.serverId,
        controllerMachineId: input.machineId,
        relationshipId: status.relationshipId,
    };
    applyWorkspaceSyncStatusEvent(scope, status);
    invalidateWorkspaceSyncConflicts(scope);
}

import { MachinePublishedWorkspaceSyncV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { invalidateWorkspaceSyncControllerConflicts } from './workspaceSyncConflictStore';
import { applyWorkspaceSyncEngineReadinessEvent } from './workspaceSyncEngineReadinessStore';
import { invalidateWorkspaceSyncStatuses } from './workspaceSyncStatusStore';

export function applyWorkspaceSyncRuntimeEvent(input: Readonly<{
    serverId: string | null;
    machineId: string;
    event: unknown;
}>): void {
    const parsed = MachinePublishedWorkspaceSyncV1Schema.safeParse(input.event);
    if (!parsed.success) return;
    applyWorkspaceSyncEngineReadinessEvent({
        serverId: input.serverId,
        machineId: input.machineId,
    }, parsed.data.readiness);
    const controller = {
        serverId: input.serverId,
        controllerMachineId: input.machineId,
    };
    invalidateWorkspaceSyncStatuses(controller);
    invalidateWorkspaceSyncControllerConflicts(controller);
}

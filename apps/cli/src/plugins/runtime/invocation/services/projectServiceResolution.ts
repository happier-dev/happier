import { ProjectServiceDeclarationRefV1Schema, type LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { ProjectManagedServiceHandle, ProjectManagedServiceResolution } from './managedServicesOwner';

/** Resolve the retained instance once; omitted qualifiers use its authoritative binding. */
export function resolveProjectManagedService(
    target: LocalServiceManagedServiceActionTargetV1,
    services: readonly ProjectManagedServiceHandle[],
): ProjectManagedServiceResolution {
    const handle = services.find(candidate => candidate.instanceId === target.managedServiceId);
    if (!handle) return Object.freeze({ status: 'unknown' });
    if (handle.kind === 'environment') {
        if (target.machineId !== handle.machineId || target.cwd !== undefined || target.declaration !== undefined
            || target.workspaceId !== undefined || target.sessionId !== undefined) return Object.freeze({ status: 'mismatch' });
        return Object.freeze({ status: 'found', handle });
    }
    const declaration = target.declaration === undefined ? undefined : ProjectServiceDeclarationRefV1Schema.safeParse(target.declaration);
    if (
        target.machineId !== handle.workspace.machineId
        || target.cwd !== undefined && target.cwd !== handle.cwd
        || declaration !== undefined && (!declaration.success || JSON.stringify(declaration.data) !== JSON.stringify(handle.declaration))
        || target.workspaceId !== undefined && target.workspaceId !== handle.workspace.id
        || target.sessionId !== undefined
    ) return Object.freeze({ status: 'mismatch' });
    return Object.freeze({ status: 'found', handle });
}

import { ProjectServiceDeclarationRefV1Schema, type LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { ProjectManagedServiceHandle, ProjectManagedServiceResolution } from './managedServicesOwner';

/** Optional qualifiers narrow a selector; the retained binding supplies omitted facts. */
export function matchesProjectManagedServiceTarget(
    target: LocalServiceManagedServiceActionTargetV1,
    binding: LocalServiceManagedServiceActionTargetV1,
): boolean {
    const declaration = target.declaration === undefined ? undefined : ProjectServiceDeclarationRefV1Schema.safeParse(target.declaration);
    return target.managedServiceId === binding.managedServiceId
        && target.machineId === binding.machineId
        && (target.cwd === undefined || target.cwd === binding.cwd)
        && (declaration === undefined || declaration.success && JSON.stringify(declaration.data) === JSON.stringify(binding.declaration))
        && (target.workspaceId === undefined || target.workspaceId === binding.workspaceId)
        && target.sessionId === undefined;
}

/** Resolve the retained instance once; omitted qualifiers use its authoritative binding. */
export function resolveProjectManagedService(
    target: LocalServiceManagedServiceActionTargetV1,
    services: readonly ProjectManagedServiceHandle[],
): ProjectManagedServiceResolution {
    const handle = services.find(candidate => candidate.instanceId === target.managedServiceId);
    if (!handle) {
        const replacement = target.declaration && services.some(candidate => candidate.kind === 'workspace'
            && candidate.workspace.machineId === target.machineId
            && (target.workspaceId === undefined || target.workspaceId === candidate.workspace.id)
            && JSON.stringify(candidate.declaration) === JSON.stringify(target.declaration));
        return Object.freeze({ status: replacement ? 'stale' : 'unknown' });
    }
    const binding = { kind: 'managed_service' as const, managedServiceId: handle.instanceId,
        ...(handle.kind === 'environment' ? { machineId: handle.machineId } : {
            machineId: handle.workspace.machineId, cwd: handle.cwd, declaration: handle.declaration, workspaceId: handle.workspace.id,
        }) };
    if (!matchesProjectManagedServiceTarget(target, binding)) return Object.freeze({ status: 'mismatch' });
    return Object.freeze({ status: 'found', handle });
}

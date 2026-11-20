/** @moduleRealm any */
import type { ManagedDependenciesService, ManagedExecutableRef } from './contract.js';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** An unreadable status cannot establish that an executable is missing. */
export async function readManagedDependencyExecutable(
    dependencies: Pick<ManagedDependenciesService, 'status'>,
    id: Parameters<ManagedDependenciesService['status']>[0],
    signal: AbortSignal,
): Promise<Readonly<{ state: 'ready'; executable: ManagedExecutableRef }> | Readonly<{ state: 'missing' | 'unsupported' | 'unknown' }>> {
    const status = await dependencies.status(id, { signal });
    if (status.state === 'missing' || status.state === 'unsupported') return { state: status.state };
    if ((status.state === 'ready' || status.state === 'updateAvailable') && status.executable) {
        return { state: 'ready', executable: status.executable };
    }
    return { state: 'unknown' };
}

export function projectUnavailableManagedDependency(
    id: Extract<ManagedPrerequisiteV1['requirement'], { kind: 'managedDependency' }>['id'],
    details: Pick<ManagedPrerequisiteV1, 'reason' | 'repairAction' | 'setupSources'> = {},
): ManagedPrerequisiteV1 {
    return { requirement: { kind: 'managedDependency', id }, status: 'unavailable', ...details };
}

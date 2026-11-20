/** @moduleRealm any */
import type { ManagedDependenciesService, ManagedExecutableRef } from './contract.js';
import type { MachineProvisionerCheckResultV1 } from '../machineProvisioners.js';

type Prerequisite = NonNullable<MachineProvisionerCheckResultV1['prerequisites']>[number];

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
    id: Prerequisite['requirement']['id'],
    details: Pick<Prerequisite, 'reason' | 'repairAction' | 'setupSources'> = {},
): Prerequisite {
    return { requirement: { kind: 'managedDependency', id }, status: 'unavailable', ...details };
}

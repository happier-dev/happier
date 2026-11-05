import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readMachineProvisionerHostAvailability } from './provisioners.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

export type ManagedMachineAcquire<T> = Readonly<{
    host: 'browser' | 'native';
    /** Account placement uses its verified reviewed-parent descriptor; native placement keeps its registry authority. */
    provisioner?: Pick<MachineProvisionerContributionV1, 'browserReachable'>;
    admit(): Promise<ManagedMachineV1>;
    onAccepted(machine: ManagedMachineV1): void | Promise<void>;
    run(machine: ManagedMachineV1): Promise<T>;
}>;

export async function executeManagedMachineAcquire<T>(input: ManagedMachineAcquire<T>): Promise<Readonly<{ machine: ManagedMachineV1; result: T }>> {
    const availability = readMachineProvisionerHostAvailability({ host: input.host, provisioner: input.provisioner ?? {} });
    if (!availability.available) throw new ManagedMachineControllerError(availability.code ?? 'provider_unavailable');
    const machine = await input.admit();
    await input.onAccepted(machine);
    return { machine, result: await input.run(machine) };
}

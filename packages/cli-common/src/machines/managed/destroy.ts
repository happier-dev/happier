import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedNativeInvocation, ManagedNativeInvocationIO } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** A retained cleanup handle owns the attachment closure after the first destroy. */
export async function executeManagedMachineDeleteIntent(input: Readonly<{
    machine: ManagedMachineV1;
    invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
}>): Promise<Readonly<{ result: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>; observation?: ProviderObservationV1 }>> {
    const { machine, invoke, io } = input;
    if (machine.desired !== 'delete' || !machine.resource && !machine.nativeOperationRef) {
        throw new ManagedMachineControllerError('native_resource_unavailable');
    }
    const result = MachineProvisionerDestroyResultV1Schema.parse(await invoke('destroy', machine.nativeOperationRef
        ? { nativeOperation: machine.nativeOperationRef.value } : { resource: machine.resource!.value }, io));
    if (result.kind === 'confirmed') {
        // The leaf confirms the resource and every owned billed attachment.
        return { result, observation: { observedAt: Date.now(), availability: 'absent' } };
    }
    if (result.kind !== 'refused' && !io?.signal?.aborted && machine.resource) {
        try {
            return { result, observation: ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value })) };
        } catch { /* Preserve issued cleanup custody when observation is unavailable. */ }
    }
    return { result };
}

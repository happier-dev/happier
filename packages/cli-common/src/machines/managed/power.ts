import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedNativeInvocation, ManagedNativeInvocationIO } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

export async function executeManagedMachinePowerIntent(input: Readonly<{
    machine: ManagedMachineV1;
    invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
    waitForObservation?(): Promise<unknown>;
    onObservation?(observation: ProviderObservationV1): Promise<void>;
}>): Promise<Readonly<{ result: ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse>; observation?: ProviderObservationV1 }>> {
    const { machine, invoke, io } = input;
    if (!machine.resource || !['start', 'resume', 'stop', 'suspend'].includes(machine.desired)) {
        throw new ManagedMachineControllerError('native_intent_unsupported');
    }
    const result = MachineProvisionerPowerResultV1Schema.parse(await invoke('power', {
        resource: machine.resource.value, intent: machine.desired,
    }, io));
    // A native acknowledgement is not a power observation. Keep ambiguous
    // delivery for the existing retained-intent owner, never resubmit it here.
    while (result.kind !== 'refused' && !io?.signal?.aborted) {
        let observation: ProviderObservationV1;
        try { observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value })); }
        catch { break; /* The acknowledged effect survives an unavailable observation. */ }
        if (!input.waitForObservation || result.kind !== 'confirmed'
            || machine.desired !== 'start' && machine.desired !== 'resume'
            || observation.availability !== 'present' || observation.storage === 'lost' || observation.power === 'running') {
            return { result, observation };
        }
        await input.onObservation?.(observation);
        await input.waitForObservation();
    }
    return { result };
}

import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1, MachineProvisionerResizeResultV1Schema, managedMachineResizeRequiresRestartV1,
    readMachineProvisionerResizeCapabilityV1, type MachineProvisionerSizeV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedResizeOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedNativeInvocation, ManagedNativeInvocationIO } from './reconcile.js';
import { executeManagedMachinePowerIntent } from './power.js';

/** Finite admitted resize: the approved size is immutable; only native observation settles it. */
export async function executeManagedMachineResize(input: Readonly<{
    machine: ManagedMachineV1; size: MachineProvisionerSizeV1; provisioner: Pick<MachineProvisionerContributionV1, 'actions' | 'resize'>; invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
    guestStartup?: Parameters<typeof executeManagedMachinePowerIntent>[0]['guestStartup'];
    waitForObservation?(): Promise<unknown>;
}>): Promise<ReturnType<typeof ManagedResizeOutputV1Schema.parse>> {
    const { machine, invoke, io } = input;
    if (!input.provisioner.actions.resize) {
        const dimension = MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.find(key => input.size[key] !== undefined)!;
        const capability = readMachineProvisionerResizeCapabilityV1(input.provisioner, dimension);
        return { result: { kind: 'unsupported', dimension, code: capability.kind === 'unsupported' ? capability.code : 'resize_unsupported' } };
    }
    if (!machine.resource) return { result: { kind: 'refused', code: 'resource_mismatch' } };
    const resource = machine.resource.value;
    const inspect = async () => ProviderObservationV1Schema.parse(await invoke('inspect', { resource }, io));
    let observation: ProviderObservationV1 | undefined;
    const power = async (intent: 'start' | 'stop' | 'suspend') => {
        const effect = await executeManagedMachinePowerIntent({ machine: { ...machine, desired: intent }, invoke, io,
            guestStartup: input.guestStartup, waitForObservation: input.waitForObservation });
        observation = effect.observation;
        if (effect.guestStartupError) return { kind: 'unknown' as const, code: effect.guestStartupError.code };
        return effect.result.kind !== 'confirmed' ? effect.result
            : effect.observation?.availability !== 'present' || effect.observation.power !== (intent === 'start' ? 'running' : intent === 'stop' ? 'stopped' : 'suspended')
                ? { kind: 'unknown' as const, code: 'native_intent_unconfirmed' } : effect.result;
    };
    const before = managedMachineResizeRequiresRestartV1(input.provisioner, input.size) ? await inspect() : undefined;
    if (before && (before.availability !== 'present' || before.storage === 'lost'
        || before.power !== 'running' && before.power !== 'stopped' && before.power !== 'suspended')) {
        return { result: { kind: 'refused', code: 'provider_unavailable' }, observation: before };
    }
    if (before && before.power !== 'stopped') {
        const stopped = await power('stop');
        if (stopped.kind !== 'confirmed') return { result: stopped, ...(observation ? { observation } : {}) };
    }
    io?.signal?.throwIfAborted();
    let result: ReturnType<typeof MachineProvisionerResizeResultV1Schema.parse>;
    try {
        result = MachineProvisionerResizeResultV1Schema.parse(await invoke('resize', { resource, size: input.size }, io));
    } catch (error) {
        if (!io?.signal?.aborted && before && (before.power === 'running' || before.power === 'suspended')) {
            try {
                await power('start');
                if (before.power === 'suspended') await power('suspend');
            } catch { /* Preserve the native resize failure; the guest remains recoverable through ordinary power controls. */ }
        }
        throw error;
    }
    // Restore only a guest this operation stopped; stopped guests stay stopped.
    if (before && (before.power === 'running' || before.power === 'suspended')) {
        try {
            const started = await power('start');
            if (result.kind !== 'refused' && result.kind !== 'unsupported' && started.kind !== 'confirmed') {
                return { result: started, ...(observation ? { observation } : {}) };
            }
            if (started.kind === 'confirmed' && before.power === 'suspended') {
                const restored = await power('suspend');
                if (result.kind !== 'refused' && result.kind !== 'unsupported' && restored.kind !== 'confirmed') {
                    return { result: restored, ...(observation ? { observation } : {}) };
                }
            }
        } catch (error) {
            if (result.kind !== 'refused' && result.kind !== 'unsupported') throw error;
        }
    }
    if (result.kind === 'refused' || result.kind === 'unsupported') return { result, ...(observation ? { observation } : {}) };
    observation = await inspect();
    const confirmed = observation.availability === 'present' && observation.storage !== 'lost'
        && MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.every(dimension => input.size[dimension] === undefined || observation!.size?.[dimension] === input.size[dimension]);
    return { result: confirmed ? { kind: 'confirmed' } : { kind: 'unknown', code: result.kind === 'unknown' ? result.code ?? 'resize_unconfirmed' : 'resize_unconfirmed',
        ...(result.kind === 'unknown' && result.nativeCause ? { nativeCause: result.nativeCause } : {}) }, observation };
}

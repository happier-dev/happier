import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerPowerResultV1Schema, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedNativeInvocation, ManagedNativeInvocationIO } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { createManagedNativeBootstrapIO, startManagedNativeGuestDaemon } from './nativeBootstrap.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../../systemTasks/ssh/remoteFirstPartyInstallPath.js';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';

export async function executeManagedMachinePowerIntent(input: Readonly<{
    machine: ManagedMachineFullV1;
    invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
    guestStartup?: Readonly<{ channel: 'stable' | 'preview' | 'dev'; transport: MachineProvisionerContributionV1['bootstrapTransport'] }>;
    waitForObservation?(): Promise<unknown>;
}>): Promise<Readonly<{ result: ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse>; observation?: ProviderObservationV1;
    guestStartupError?: ManagedMachineControllerError }>> {
    const { machine, invoke, io } = input;
    if (!machine.resource || !['start', 'resume', 'stop', 'suspend'].includes(machine.desired)) {
        throw new ManagedMachineControllerError('native_intent_unsupported');
    }
    // Stored observations describe the last reconciliation, not vendor power now.
    // Inspect at this one native-effect owner before deciding whether wake is needed.
    const waking = machine.desired === 'start' || machine.desired === 'resume';
    const beforeWake = waking
        ? ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value }, { signal: io?.signal }))
        : undefined;
    if (beforeWake && (beforeWake.availability !== 'present' || beforeWake.storage === 'lost'
        || beforeWake.power !== 'running' && beforeWake.power !== 'stopped' && beforeWake.power !== 'suspended')) {
        // No power effect was dispatched. Report the refusing observation so
        // Home settles this submission and retains native absence or loss.
        return { result: { kind: 'refused', code: 'provider_unavailable',
            ...(beforeWake.nativeCause ? { nativeCause: beforeWake.nativeCause } : {}) }, observation: beforeWake };
    }
    const result = beforeWake?.power === 'running' ? { kind: 'confirmed' as const }
        : MachineProvisionerPowerResultV1Schema.parse(await invoke('power', {
            resource: machine.resource.value, intent: machine.desired,
        }, io));
    const complete = async (observation: ProviderObservationV1) => {
        const power = { result, observation };
        if (result.kind !== 'confirmed' || machine.desired !== 'start' && machine.desired !== 'resume'
            || observation.availability !== 'present' || observation.power !== 'running' || observation.storage === 'lost'
            || !machine.enrolledMachineId || machine.enrollmentIdentity?.kind === 'dedicatedDaemonUser'
            || input.guestStartup?.transport?.kind !== 'native') return power;
        try {
            const carrier = ManagedBootstrapCarrierV1Schema.parse(await invoke('bootstrap', { resource: machine.resource!.value }, io));
            if (carrier.kind !== 'native' || !sameStrictJsonValue(carrier.transport.contributionRef, machine.resource!.contributionRef)
                || carrier.transport.schemaVersion !== machine.resource!.schemaVersion) throw new ManagedMachineControllerError('resource_mismatch');
            if (!carrier.guestHome && machine.enrollmentIdentity?.kind !== 'guestProcess') return power;
            await startManagedNativeGuestDaemon({ native: createManagedNativeBootstrapIO({ resource: machine.resource! }, invoke),
                channel: input.guestStartup.channel, guestHome: carrier.guestHome, signal: io?.signal,
                binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli',
                    channel: input.guestStartup.channel, remoteHomeDir: carrier.guestHome?.happyHomeDir }) });
            return power;
        } catch (error) {
            return { ...power, guestStartupError: error instanceof ManagedMachineControllerError ? error
                : new ManagedMachineControllerError(io?.signal?.aborted ? 'cancelled' : 'native_boot_unconfirmed', undefined,
                    error instanceof SystemTaskExecutionError ? error.details : undefined,
                    projectActionFailureCauseV1(error, 'machines.managed.power.set'), error) };
        }
    };
    if (beforeWake?.power === 'running') return await complete(beforeWake);
    // A native acknowledgement is not a power observation. Keep ambiguous
    // delivery for the existing retained-intent owner, never resubmit it here.
    while (result.kind !== 'refused' && !io?.signal?.aborted) {
        let observation: ProviderObservationV1;
        try { observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value })); }
        catch { break; /* The acknowledged effect survives an unavailable observation. */ }
        if (input.waitForObservation && observation.availability === 'unavailable' && observation.reason === 'transport') {
            await input.waitForObservation();
            continue;
        }
        if (!input.waitForObservation || result.kind !== 'confirmed'
            || machine.desired !== 'start' && machine.desired !== 'resume'
            || observation.availability !== 'present' || observation.storage === 'lost' || observation.power === 'running') {
            return await complete(observation);
        }
        await input.waitForObservation();
    }
    return { result };
}

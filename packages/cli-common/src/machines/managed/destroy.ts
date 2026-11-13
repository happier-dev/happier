import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedNativeInvocation, ManagedNativeInvocationIO } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { createManagedNativeObservationWait } from './nativeObservationWait.js';

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

/** Foreground Account hosts settle the same retained native cleanup through Home's row owner. */
export async function settleManagedMachineDeleteIntent(input: Readonly<{
    machine: ManagedMachineV1;
    invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
    report(deletion: Awaited<ReturnType<typeof executeManagedMachineDeleteIntent>>): Promise<ManagedMachineV1>;
    onNativeFailureReportError(error: unknown): void;
}>): Promise<ManagedMachineV1> {
    let machine = input.machine;
    const wait = createManagedNativeObservationWait(input.io?.signal);
    for (;;) {
        input.io?.signal?.throwIfAborted();
        const deletion = await executeManagedMachineDeleteIntent({ machine, invoke: input.invoke, io: input.io });
        const nativeFailure = deletion.result.kind === 'refused'
            ? new ManagedMachineControllerError(deletion.result.code, undefined,
                deletion.result.nativeCause ? { kind: 'managedNative', nativeCause: deletion.result.nativeCause } : undefined) : undefined;
        try { machine = await input.report(deletion); }
        catch (reportError) {
            if (!nativeFailure) throw reportError;
            input.onNativeFailureReportError(reportError);
        }
        if (nativeFailure) throw nativeFailure;
        if (machine.allocation === 'confirmed-absent' && !machine.submittedNativeEffect) return machine;
        if (deletion.result.kind !== 'accepted' && deletion.result.kind !== 'pending') {
            throw new ManagedMachineControllerError(deletion.result.kind === 'confirmed' ? 'native_intent_unconfirmed'
                : deletion.result.code ?? 'native_intent_unconfirmed');
        }
        await wait();
    }
}

import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { reconcileManagedAcquisitionIdentity, settleManagedNativeIntent, type ManagedMachineReconciliation, type ManagedReconciliationReportHome,
    type ManagedNativeInvocation, type ManagedNativeInvocationIO } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { createManagedNativeObservationWait } from './nativeObservationWait.js';

/** Recover uncertain acquisition identity before claiming Delete; an issued Delete keeps its cleanup custody. */
export async function prepareManagedMachineDeleteIntent(input: Readonly<Pick<ManagedMachineReconciliation, 'requestId' | 'provisioner' | 'signal'> & {
    machine: ManagedMachineFullV1;
    home: ManagedReconciliationReportHome;
    invoke: ManagedNativeInvocation;
}>): Promise<ManagedMachineFullV1> {
    const { machine } = input;
    const canceledCleanup = machine.creationState === 'canceled' && machine.archivedAt === undefined;
    if (machine.desired !== 'delete' || machine.desiredWhen !== 'now' || machine.allocation !== 'may-exist'
        || machine.resource || machine.submittedNativeEffect?.intent === 'delete'
        || machine.nativeOperationRef && !machine.recovery && !canceledCleanup) return machine;
    const current = await reconcileManagedAcquisitionIdentity({ ...input, action: 'machines.managed.delete' }, machine, input.invoke);
    if (!current.resource && current.allocation !== 'confirmed-absent' && (machine.recovery || !current.nativeOperationRef)) {
        const nativeCause = current.observation?.nativeCause;
        throw new ManagedMachineControllerError(current.observation?.reason ?? current.recovery?.reason ?? 'native_acquisition_unconfirmed',
            undefined, nativeCause ? { kind: 'managedNative', nativeCause } : undefined);
    }
    return current;
}

/** A retained cleanup handle owns the attachment closure after the first destroy. */
export async function executeManagedMachineDeleteIntent(input: Readonly<{
    machine: ManagedMachineFullV1;
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
    machine: ManagedMachineFullV1;
    invoke: ManagedNativeInvocation;
    io?: ManagedNativeInvocationIO;
    report(deletion: Awaited<ReturnType<typeof executeManagedMachineDeleteIntent>>): Promise<ManagedMachineFullV1>;
    onNativeFailureReportError(error: unknown): void;
}>): Promise<ManagedMachineFullV1> {
    let machine = input.machine;
    const wait = createManagedNativeObservationWait(input.io?.signal);
    for (;;) {
        input.io?.signal?.throwIfAborted();
        const deletion = await settleManagedNativeIntent({
            invoke: () => executeManagedMachineDeleteIntent({ machine, invoke: input.invoke, io: input.io }),
            report: async outcome => { machine = await input.report(outcome); },
            onReportFailure: input.onNativeFailureReportError,
        });
        if (machine.allocation === 'confirmed-absent' && !machine.submittedNativeEffect) return machine;
        if (deletion.result.kind !== 'accepted' && deletion.result.kind !== 'pending') {
            throw new ManagedMachineControllerError(deletion.result.kind === 'confirmed' ? 'native_intent_unconfirmed'
                : deletion.result.code ?? 'native_intent_unconfirmed');
        }
        await wait();
    }
}

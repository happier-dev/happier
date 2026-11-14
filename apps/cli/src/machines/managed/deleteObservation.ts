import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineControllerError, ManagedMachineNativeObservationFailure } from './controllerErrors';
import { createManagedNativeObservationWait } from './nativeObservationWait';
import type { ManagedMachineReconciliationInput } from './reconcile';

/** Diagnostic failures stop observation; bare unknown retains delivery uncertainty. */
export function assertManagedDeleteNativeResult(result: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>): void {
    if (result.kind === 'refused' || (result.kind === 'unknown' && (result.code !== undefined || result.nativeCause !== undefined))) {
        throw new ManagedMachineNativeObservationFailure(result.code ?? 'native_intent_unconfirmed', undefined,
            result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
    }
}

/** Positive pending evidence, never an ambiguous delivery of a fresh destroy. */
export function canObserveAcceptedManagedDelete(machine: ManagedMachineFullV1,
    result: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>): boolean {
    return machine.submittedNativeEffect?.intent === 'delete' && (result.kind === 'accepted' || result.kind === 'pending');
}

/** One admitted Delete observes its exact resource or continues its retained native cleanup handle. */
export async function observeAcceptedManagedDelete(params: ManagedMachineReconciliationInput, observed: ManagedMachineFullV1,
    observe: (machine: ManagedMachineFullV1, outstanding: NonNullable<ManagedMachineFullV1['submittedNativeEffect']>) => Promise<ManagedMachineFullV1>,
): Promise<ManagedMachineFullV1> {
    let machine = observed;
    const wait = createManagedNativeObservationWait(params.options.signal);
    let changed = false;
    let wake: (() => void) | undefined;
    const unsubscribe = params.input.subscribeManagedMachineChanges?.(change => {
        if (change?.kind !== 'managed' || !change.managedIds.includes(machine.id)) return;
        changed = true;
        wake?.();
    });
    const readCurrent = async () => {
        if (params.options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
        const current = await params.client.readCurrent(machine, 'inspect');
        if (!current) throw new ManagedMachineControllerError('intent_changed');
        machine = current;
        return Boolean(machine.submittedNativeEffect);
    };
    const assertReadable = () => {
        // A retained Delete handle owns attachment closure and its advancing phases.
        // Generic resource inspection may be unavailable until that closure completes.
        if (machine.nativeOperationRef) return;
        if (machine.observation?.availability === 'unavailable'
            && (machine.observation.reason !== 'native_cleanup_incomplete' || machine.observation.nativeCause)) {
            throw new ManagedMachineNativeObservationFailure(machine.observation.reason ?? 'native_resource_unavailable', undefined,
                machine.observation.nativeCause ? { kind: 'managedNative', nativeCause: machine.observation.nativeCause } : undefined);
        }
    };
    try {
        assertReadable();
        params.options.context?.operationOwnerUpdate?.update({ cancellation: 'supported', progress: {
            phase: 'managed.intent.waiting-delete', label: 'Waiting for machine deletion',
        } });
        let pending = await readCurrent();
        while (pending) {
            const deadline = await wait({
                waitForChange: signal => new Promise<void>(resolve => {
                    const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve(); };
                    wake = finish;
                    signal.addEventListener('abort', finish, { once: true });
                    if (changed || signal.aborted) finish();
                }),
                onChange: async () => { changed = false; return await readCurrent(); },
            });
            if (!deadline || !await readCurrent()) break;
            machine = await observe(machine, machine.submittedNativeEffect!);
            pending = Boolean(machine.submittedNativeEffect);
            assertReadable();
            // The report response already incorporates its own synchronous
            // notification. Do not clear a push received during the initial read.
            changed = false;
        }
        if (machine.allocation !== 'confirmed-absent' || machine.observation?.availability !== 'absent'
            || machine.submittedNativeEffect) throw new ManagedMachineControllerError('native_intent_unconfirmed');
        return machine;
    } finally {
        unsubscribe?.();
    }
}

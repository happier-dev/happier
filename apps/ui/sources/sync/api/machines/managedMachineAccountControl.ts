import { ManagedMachineControllerError, createManagedNativeObservationWait, executeManagedMachineDeleteIntent,
    executeManagedMachinePowerIntent } from '@happier-dev/cli-common/machines/managed';
import { ManagedControlAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiManagedAccountHome, createUiManagedAccountHomeRequest } from './managedMachineAccountHome';
import { createUiManagedAccountNative, readUiManagedAccountAdmission } from './managedMachineAccountNative';
import { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

type Control = Readonly<{ action: 'machines.managed.power.set'; input: ManagedMachineActionInputV1<'machines.managed.power.set'> }>
    | Readonly<{ action: 'machines.managed.delete'; input: ManagedMachineActionInputV1<'machines.managed.delete'> }>;

/** Home admits the intent once; the foreground Account continues its retained native effects. */
export async function executeUiManagedAccountControl(params: Readonly<{
    account: LazyActionAccountContext; context: ActionExecutorContext; signal?: AbortSignal;
}>, control: Control): Promise<ActionExecuteResult> {
    const requestId = params.context.actionRequestId!;
    const post = createUiManagedAccountHomeRequest(params);
    const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
    try {
        let machine = (await post('admit-control', ManagedControlAdmissionInputV1Schema.parse({ ...control, requestId }),
            ManagedAdmissionOutputV1Schema)).machine;
        const accepted = (): ActionExecuteResult => ({ ok: true, result: { kind: 'accepted', managedId: machine.id,
            intentRevision: machine.intentRevision,
            ...(params.context.operationAcceptance ? { operation: { operationId: params.context.operationAcceptance.operationId } } : {}) } });
        if (machine.desiredWhen !== 'now') return accepted();
        const admitted = readUiManagedAccountAdmission(params.context, machine);
        const client = createUiManagedAccountHome({ ...params, requestId, provisioner: admitted.provisioner });
        const submitted = await post('submit-intent', client.home.correlation(machine), ManagedControllerSubmitOutputV1Schema);
        machine = submitted.machine;
        const outstanding = machine.submittedNativeEffect;
        if (!submitted.submitted && (control.action !== 'machines.managed.delete' || outstanding?.intent !== 'delete')) {
            return failure('action_outcome_unknown');
        }
        const correlation = outstanding ? { ...client.home.correlation(machine), requestId: outstanding.requestId,
            expectedIntentRevision: outstanding.intentRevision, controller: outstanding.controller } : client.home.correlation(machine);
        const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
        const native = createUiManagedAccountNative({ ...params, requestId }, admitted, () => machine, () => undefined, credential);
        const wait = createManagedNativeObservationWait(params.signal);
        if (control.action === 'machines.managed.delete') {
            for (;;) {
                params.signal?.throwIfAborted();
                const deletion = await executeManagedMachineDeleteIntent({ machine, invoke: native.invoke, io: { signal: params.signal } });
                machine = await client.home.row('report-intent', { ...correlation, ...deletion }, null);
                if (machine.allocation === 'confirmed-absent' && !machine.submittedNativeEffect) return accepted();
                if (deletion.result.kind !== 'accepted' && deletion.result.kind !== 'pending') {
                    return failure(deletion.result.kind === 'confirmed' ? 'native_intent_unconfirmed'
                        : deletion.result.code ?? 'native_intent_unconfirmed');
                }
                // External vendor completion has no push; reuse the existing native observation cadence.
                await wait();
            }
        }
        const power = await executeManagedMachinePowerIntent({ machine, invoke: native.invoke,
            guestStartup: { channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), transport: admitted.provisioner.bootstrapTransport },
            io: { signal: params.signal }, waitForObservation: wait });
        machine = await client.home.row('report-intent', { ...correlation, result: power.result, observation: power.observation }, null);
        if (power.guestStartupError) return failure(power.guestStartupError.code);
        if (power.result.kind !== 'confirmed' || !power.observation) {
            return failure(power.result.kind === 'confirmed' ? 'action_outcome_unknown' : power.result.code ?? 'action_outcome_unknown');
        }
        return accepted();
    } catch (error) {
        if (error instanceof ManagedMachineControllerError) return failure(error.code);
        throw error;
    }
}

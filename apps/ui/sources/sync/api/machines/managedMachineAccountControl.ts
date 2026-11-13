import { MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedMachineControllerError, createManagedNativeObservationWait, settleManagedMachineDeleteIntent,
    executeManagedMachinePowerIntent, executeManagedMachineResize } from '@happier-dev/cli-common/machines/managed';
import { ManagedControlAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    ManagedControllerResizeReportV1Schema, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectActionFailureCauseV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiManagedAccountHome, createUiManagedAccountHomeRequest } from './managedMachineAccountHome';
import { createUiManagedAccountNative, readUiManagedAccountAdmission } from './managedMachineAccountNative';
import { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { log } from '@/log';

type Control = Readonly<{ action: 'machines.managed.resize'; input: ManagedMachineActionInputV1<'machines.managed.resize'> }>
    | Readonly<{ action: 'machines.managed.power.set'; input: ManagedMachineActionInputV1<'machines.managed.power.set'> }>
    | Readonly<{ action: 'machines.managed.delete'; input: ManagedMachineActionInputV1<'machines.managed.delete'> }>;

/** Home admits the intent once; the foreground Account continues its retained native effects. */
export async function executeUiManagedAccountControl(params: Readonly<{
    account: LazyActionAccountContext; context: ActionExecutorContext; signal?: AbortSignal;
}>, control: Control): Promise<ActionExecuteResult> {
    const requestId = params.context.actionRequestId!;
    const post = createUiManagedAccountHomeRequest(params);
    const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
    try {
        const admission = await post('admit-control', ManagedControlAdmissionInputV1Schema.parse({ ...control, requestId }),
            ManagedAdmissionOutputV1Schema);
        let machine = admission.machine;
        if (control.action === MANAGED_RESIZE_ACTION_ID_V1) {
            const provisioner = admission.resizeProvisioner;
            if (!provisioner) return failure('admission_unavailable');
            const admitted = { provisioner, providerPluginId: machine.launch.provider.pluginId };
            const client = createUiManagedAccountHome({ ...params, requestId, provisioner });
            const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
            const native = createUiManagedAccountNative({ ...params, requestId }, admitted, () => machine, () => undefined, credential);
            const output = await executeManagedMachineResize({ machine, size: control.input.size, provisioner, invoke: native.invoke,
                io: { signal: params.signal },
                guestStartup: { channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), transport: provisioner.bootstrapTransport },
                waitForObservation: createManagedNativeObservationWait(params.signal) });
            await client.home.row('report-resize', ManagedControllerResizeReportV1Schema.parse({
                homeId: machine.homeId, managedId: machine.id, requestId, ...output,
            }), null);
            return { ok: true, result: output };
        }
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
        if (control.action === 'machines.managed.delete') {
            machine = await settleManagedMachineDeleteIntent({ machine, invoke: native.invoke, io: { signal: params.signal },
                report: async deletion => machine = await client.home.row('report-intent', { ...correlation, ...deletion }, null),
                onNativeFailureReportError: error => log.log(JSON.stringify(projectActionFailureCauseV1(error, control.action))),
            });
            return accepted();
        }
        const wait = createManagedNativeObservationWait(params.signal);
        const power = await executeManagedMachinePowerIntent({ machine, invoke: native.invoke,
            guestStartup: { channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), transport: admitted.provisioner.bootstrapTransport },
            io: { signal: params.signal }, waitForObservation: wait });
        const nativeFailure = power.guestStartupError ?? (power.result.kind === 'refused'
            ? new ManagedMachineControllerError(power.result.code, undefined,
                power.result.nativeCause ? { kind: 'managedNative', nativeCause: power.result.nativeCause } : undefined) : undefined);
        try {
            machine = await client.home.row('report-intent', { ...correlation, result: power.result, observation: power.observation }, null);
        } catch (reportError) {
            if (!nativeFailure) throw reportError;
            log.log(JSON.stringify(projectActionFailureCauseV1(reportError, control.action)));
        }
        if (nativeFailure) throw nativeFailure;
        if (power.result.kind !== 'confirmed' || !power.observation) {
            return failure(power.result.kind === 'confirmed' ? 'action_outcome_unknown' : power.result.code ?? 'action_outcome_unknown');
        }
        return accepted();
    } catch (error) {
        if (error instanceof ManagedMachineControllerError) return { ok: false, ...normalizeActionExecutorThrownError(error, control.action) };
        throw error;
    }
}

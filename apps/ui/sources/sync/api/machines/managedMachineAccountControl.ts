import { MANAGED_DELETE_ACTION_ID_V1, MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedMachineControllerError, createManagedNativeObservationWait, prepareManagedMachineDeleteIntent, settleManagedMachineDeleteIntent,
    assertManagedPowerIntentConfirmed, executeManagedMachinePowerIntent, settleManagedMachineResize, settleManagedNativeIntent } from '@happier-dev/cli-common/machines/managed';
import { ManagedControlAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerResizeReportV1Schema, ManagedOpaquePresetResizeInputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectActionFailureCauseV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isManagedOpaquePresetMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiManagedAccountHome, createUiManagedAccountHomeRequest,
    normalizeUiManagedAccountMachine } from './managedMachineAccountHome';
import { createUiManagedAccountNative, readUiManagedAccountAdmission } from './managedMachineAccountNative';
import { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import { hydrateUiManagedOpaquePreset, isUiManagedOpaquePresetCarrier,
    type UiManagedOpaquePresetHydration } from './managedMachineAccountAcquire';
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
        const admittedMachine = admission.machine;
        const opaqueCarrier = isUiManagedOpaquePresetCarrier(admission) ? admission : null;
        if (isManagedOpaquePresetMachineV1(admittedMachine) && !opaqueCarrier) return failure('content_unavailable');
        const opaque = opaqueCarrier === null ? null : await hydrateUiManagedOpaquePreset({ account: params.account,
            carrier: opaqueCarrier, signal: params.signal });
        try {
            let machine = opaque?.machine ?? normalizeUiManagedAccountMachine(undefined, admittedMachine);
            if (control.action === MANAGED_RESIZE_ACTION_ID_V1) {
                let resolved: ReturnType<UiManagedOpaquePresetHydration['prepareResize']> | null = null;
                if (opaque !== null) {
                    const opaqueResize = ManagedOpaquePresetResizeInputV1Schema.safeParse(control.input);
                    if (!opaqueResize.success) return failure('content_unavailable');
                    resolved = opaque.prepareResize(opaqueResize.data.presetContentOverride);
                    machine = resolved.machine;
                }
                const size = resolved?.size ?? ('size' in control.input ? control.input.size : null);
                if (!size) return failure('content_unavailable');
                const provisioner = opaque?.admission.provisioner ?? admission.resizeProvisioner;
                if (!provisioner) return failure('admission_unavailable');
                const admitted = { provisioner, providerPluginId: machine.launch.provider.pluginId };
                const client = createUiManagedAccountHome({ ...params, requestId, provisioner,
                    ...(opaque === null ? {} : { normalizer: opaque.normalizer }) });
                const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
                const native = createUiManagedAccountNative({ ...params, requestId }, admitted, () => machine, () => undefined, credential);
                const result = await settleManagedMachineResize({ machine, size, provisioner, invoke: native.invoke, requestId,
                    io: { signal: params.signal },
                    guestStartup: { channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), transport: provisioner.bootstrapTransport },
                    waitForObservation: createManagedNativeObservationWait(params.signal),
                    onReportFailure: error => log.log(JSON.stringify(projectActionFailureCauseV1(error, control.action))),
                    report: async body => {
                        if (opaque === null) {
                            const { result, observation } = body;
                            await client.home.row('report-resize', ManagedControllerResizeReportV1Schema.parse(body), null);
                            return { result, ...(observation === undefined ? {} : { observation }) };
                        }
                        const report = opaque.prepareResizeReport(body);
                        if (!report) throw new ManagedMachineControllerError('content_unavailable');
                        await post('report-resize', ManagedControllerResizeReportV1Schema.parse(report), ManagedControllerMachineOutputV1Schema, null);
                        return { result: report.result, presetContent: report.presetContent,
                            ...(report.observation === undefined ? {} : { observation: report.observation }) };
                    },
                });
                return { ok: true, result };
            }
            const accepted = (): ActionExecuteResult => ({ ok: true, result: { kind: 'accepted', managedId: machine.id,
                intentRevision: machine.intentRevision,
                ...(params.context.operationAcceptance ? { operation: { operationId: params.context.operationAcceptance.operationId } } : {}) } });
            if (machine.desiredWhen !== 'now') return accepted();
            const admitted = readUiManagedAccountAdmission(params.context, machine);
            const client = createUiManagedAccountHome({ ...params, requestId, provisioner: admitted.provisioner,
                ...(opaque === null ? {} : { normalizer: opaque.normalizer }) });
            const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
            const native = createUiManagedAccountNative({ ...params, requestId }, admitted, () => machine, () => undefined, credential);
            if (control.action === MANAGED_DELETE_ACTION_ID_V1) {
                machine = await prepareManagedMachineDeleteIntent({ machine, requestId, provisioner: admitted.provisioner,
                    home: client.home, invoke: native.invoke, signal: params.signal });
                if (machine.allocation === 'confirmed-absent') return accepted();
            }
            const submitted = await post('submit-intent', client.home.correlation(machine), ManagedControllerSubmitOutputV1Schema);
            machine = normalizeUiManagedAccountMachine(opaque?.normalizer, submitted.machine);
            const outstanding = machine.submittedNativeEffect;
            if (!submitted.submitted && (control.action !== MANAGED_DELETE_ACTION_ID_V1 || outstanding?.intent !== 'delete')) {
                return failure('native_intent_unconfirmed');
            }
            const correlation = outstanding ? { ...client.home.correlation(machine), requestId: outstanding.requestId,
                expectedIntentRevision: outstanding.intentRevision, controller: outstanding.controller } : client.home.correlation(machine);
            if (control.action === MANAGED_DELETE_ACTION_ID_V1) {
                machine = await settleManagedMachineDeleteIntent({ machine, invoke: native.invoke, io: { signal: params.signal },
                    report: async deletion => machine = await client.home.row('report-intent', { ...correlation, ...deletion }, null),
                    onNativeFailureReportError: error => log.log(JSON.stringify(projectActionFailureCauseV1(error, control.action))),
                });
                return accepted();
            }
            const power = await settleManagedNativeIntent({
                invoke: () => executeManagedMachinePowerIntent({ machine, invoke: native.invoke,
                    guestStartup: { channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), transport: admitted.provisioner.bootstrapTransport },
                    io: { signal: params.signal }, waitForObservation: createManagedNativeObservationWait(params.signal) }),
                report: async outcome => { machine = await client.home.row('report-intent', { ...correlation, ...outcome }, null); },
                onReportFailure: error => log.log(JSON.stringify(projectActionFailureCauseV1(error, control.action))),
            });
            assertManagedPowerIntentConfirmed(machine, power);
            return accepted();
        } finally {
            opaque?.dispose();
        }
    } catch (error) {
        if (error instanceof ManagedMachineControllerError) {
            return error.toActionFailure(control.action);
        }
        throw error;
    }
}

import { prepareManagedMachineDeleteIntent, settleManagedMachineDeleteIntent, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerCurrentnessV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { logger } from '@/ui/logger';
import { createCliManagedAccountNativeInvocation, resolveCliManagedAccountProvisioner } from './accountNative';
import type { executeCliManagedAccountPower } from './accountPower';
import { createManagedPresetHydrator, openManagedPresetCarrier } from './presetHydration';

/** Account deletion consumes the retained control admission and reports the native cleanup owner's result. */
export async function executeCliManagedAccountDelete(input: Omit<Parameters<typeof executeCliManagedAccountPower>[0], 'body'> & Readonly<{
    body: ManagedMachineActionInputV1<'machines.managed.delete'>;
}>) {
    const requestId = input.context.actionRequestId;
    if (!requestId) throw new ManagedMachineControllerError('admission_unavailable');
    const admitted = await input.post('admit-control', ManagedControlAdmissionInputV1Schema.parse({
        action: 'machines.managed.delete', input: input.body, requestId }), ManagedAdmissionOutputV1Schema);
    const accepted = (machine: Readonly<{ id: string; intentRevision: number }>) => ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: machine.id,
        intentRevision: machine.intentRevision,
        ...(input.context.operationAcceptance ? { operation: { operationId: input.context.operationAcceptance.operationId } } : {}),
    });
    if (admitted.machine.desiredWhen !== 'now' || admitted.machine.allocation === 'confirmed-absent') return accepted(admitted.machine);
    const hydrator = createManagedPresetHydrator(input);
    let { machine } = await openManagedPresetCarrier(admitted, hydrator, input.signal);
    if (!input.context.hostReviewedChild) throw new ManagedMachineControllerError('admission_unavailable');
    if (machine.controller) throw new ManagedMachineControllerError('controller_unavailable');
    let selected: Awaited<ReturnType<typeof readCurrentAccountPluginExecutionSelection>> | undefined;
    if (!machine.reviewedFacts?.provisioner) {
        selected = await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
            credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
    }
    const provisioner = machine.reviewedFacts?.provisioner
        ?? (selected?.kind === 'available' ? resolveCliManagedAccountProvisioner(machine, selected) : undefined);
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    const correlation = (current = machine) => ManagedControllerCurrentnessV1Schema.parse({ homeId: current.homeId, managedId: current.id,
        expectedIntentRevision: current.intentRevision, requestId });
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        selected ??= await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
            credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
        const native = createCliManagedAccountNativeInvocation({ machine, provisioner, selected,
            context: input.context, signal: input.signal, requestId });
        return native(role, body, io);
    };
    machine = await prepareManagedMachineDeleteIntent({ machine, requestId, provisioner, invoke, signal: input.signal,
        home: { correlation, row: async (path, body, signal) => {
            const request = await hydrator.prepareControllerReport(path, body, signal ?? undefined);
            return hydrator.normalize((await input.post(path, request, ManagedControllerMachineOutputV1Schema, signal)).machine);
        } } });
    if (machine.allocation === 'confirmed-absent') return accepted(machine);
    const submitted = await input.post('submit-intent', correlation(), ManagedControllerSubmitOutputV1Schema);
    machine = hydrator.normalize(submitted.machine);
    const outstanding = machine.submittedNativeEffect;
    if (!submitted.submitted && outstanding?.intent !== 'delete') throw new ManagedMachineControllerError('native_intent_unconfirmed');
    const retainedCorrelation = outstanding ? { ...correlation(), requestId: outstanding.requestId,
        expectedIntentRevision: outstanding.intentRevision, controller: outstanding.controller } : correlation();
    machine = await settleManagedMachineDeleteIntent({ machine, invoke, io: { signal: input.signal },
        report: async deletion => {
            const body = await hydrator.prepareControllerReport('report-intent', { ...retainedCorrelation, ...deletion });
            return machine = hydrator.normalize((await input.post('report-intent', body,
                ManagedControllerMachineOutputV1Schema, null)).machine);
        },
        onNativeFailureReportError: error => logger.warn('[MANAGED MACHINE] Native cleanup report failed',
            projectActionFailureCauseV1(error, 'machines.managed.delete')),
    });
    return accepted(machine);
}

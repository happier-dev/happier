import { settleManagedMachineDeleteIntent, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerCurrentnessV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { logger } from '@/ui/logger';
import { createCliManagedAccountNativeInvocation } from './accountNative';
import type { executeCliManagedAccountPower } from './accountPower';

/** Account deletion consumes the retained control admission and reports the native cleanup owner's result. */
export async function executeCliManagedAccountDelete(input: Omit<Parameters<typeof executeCliManagedAccountPower>[0], 'body'> & Readonly<{
    body: ManagedMachineActionInputV1<'machines.managed.delete'>;
}>) {
    const requestId = input.context.actionRequestId;
    if (!requestId) throw new ManagedMachineControllerError('admission_unavailable');
    const admitted = await input.post('admit-control', ManagedControlAdmissionInputV1Schema.parse({
        action: 'machines.managed.delete', input: input.body, requestId }), ManagedAdmissionOutputV1Schema);
    let machine = admitted.machine;
    const accepted = () => ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: machine.id,
        intentRevision: machine.intentRevision,
        ...(input.context.operationAcceptance ? { operation: { operationId: input.context.operationAcceptance.operationId } } : {}),
    });
    if (machine.desiredWhen !== 'now' || machine.allocation === 'confirmed-absent') return accepted();
    if (!input.context.hostReviewedChild) throw new ManagedMachineControllerError('admission_unavailable');
    if (machine.controller) throw new ManagedMachineControllerError('controller_unavailable');
    const provisioner = machine.reviewedFacts?.provisioner;
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    const correlation = ManagedControllerCurrentnessV1Schema.parse({ homeId: machine.homeId, managedId: machine.id,
        expectedIntentRevision: machine.intentRevision, requestId });
    const submitted = await input.post('submit-intent', correlation, ManagedControllerSubmitOutputV1Schema);
    machine = submitted.machine;
    const outstanding = machine.submittedNativeEffect;
    if (!submitted.submitted && outstanding?.intent !== 'delete') throw new ManagedMachineControllerError('action_outcome_unknown');
    const retainedCorrelation = outstanding ? { ...correlation, requestId: outstanding.requestId,
        expectedIntentRevision: outstanding.intentRevision, controller: outstanding.controller } : correlation;
    let selected: Awaited<ReturnType<typeof readCurrentAccountPluginExecutionSelection>> | undefined;
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        selected ??= await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
            credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
        const native = createCliManagedAccountNativeInvocation({ machine, provisioner, selected,
            context: input.context, signal: input.signal, requestId });
        return native(role, body, io);
    };
    machine = await settleManagedMachineDeleteIntent({ machine, invoke, io: { signal: input.signal },
        report: async deletion => machine = (await input.post('report-intent', { ...retainedCorrelation, ...deletion },
            ManagedControllerMachineOutputV1Schema, null)).machine,
        onNativeFailureReportError: error => logger.warn('[MANAGED MACHINE] Native cleanup report failed',
            projectActionFailureCauseV1(error, 'machines.managed.delete')),
    });
    return accepted();
}

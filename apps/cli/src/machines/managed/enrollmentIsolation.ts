import type { ActionExecuteResult } from '@happier-dev/protocol';
import { applyManagedMachineEnrollmentIsolation, type ManagedEnrollmentIsolationRequest } from '@happier-dev/cli-common/machines/managed';
import { resolveManagedMachineEnrollmentAgentIsolationV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { dispatchManagedMachineAgentIsolation, dispatchLocalManagedMachineAgentIsolation } from '@/api/externalActionExecutionAuthorization';
import type { ManagedMachineAcquisitionDriverInput, ManagedMachineExecutionOptions } from './acquire';
import { ManagedMachineControllerError } from './controllerErrors';
import { resolveManagedCreationChildMaterial } from './creationChildMaterial';

/** Creation/recovery consumes the same reviewed guest policy owner as manual changes. */
export async function initializeManagedMachineEnrollmentIsolation(machine: ManagedMachineV1, input: ManagedMachineAcquisitionDriverInput,
    options: ManagedMachineExecutionOptions): Promise<void> {
    const policy = resolveManagedMachineEnrollmentAgentIsolationV1(machine.enrollmentIdentity);
    if (!policy) return;
    options.context?.operationProgress?.update({ phase: 'machines.agentIsolation.preview', label: 'Reviewing Agent isolation' });
    const context = options.context;
    if (!context || !machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    const target = { serverId: machine.homeId, machineId: machine.enrolledMachineId };
    const continuation = { managedId: machine.id, creationRequestId: options.requestId, expectedIntentRevision: machine.intentRevision };
    const dispatch = async (request: ManagedEnrollmentIsolationRequest) => {
        if (request.actionId === 'machines.agentIsolation.set')
            options.context?.operationProgress?.update({ phase: request.actionId, label: 'Configuring Agent isolation' });
        const authorization = context.externalActionExecutionAuthorization;
        let execution: ActionExecuteResult;
        if (authorization) {
            if (!input.externalActionMachineRequestPrivateKey || authorization.binding.machineId !== input.controller.machineId
                || authorization.binding.installationId !== input.controller.installationId
                || authorization.binding.serverIdentityId !== machine.homeId) throw new ManagedMachineControllerError('admission_unavailable');
            const material = await resolveManagedCreationChildMaterial(authorization, machine.homeId, options.signal);
            execution = await dispatchManagedMachineAgentIsolation({ ...request,
                observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
                serverId: context.serverId ?? machine.homeId, homeTarget: input.homeTarget, context, continuation,
                authorization, authority: context.authority, installationId: input.controller.installationId,
                privateKey: input.externalActionMachineRequestPrivateKey, serverHttpBaseUrl: input.serverUrl,
                ...(material ? { material } : {}), signal: options.signal });
        } else {
            execution = await dispatchLocalManagedMachineAgentIsolation({ ...request, homeId: machine.homeId, context,
                observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
                managedContinuation: continuation, credentials: input.credentials, custodianAccountId: machine.custodianAccountId,
                serverHttpBaseUrl: input.serverUrl, isCurrent: async () => !options.signal?.aborted });
        }
        if (!execution.ok) throw ManagedMachineControllerError.fromActionFailure(execution, request.actionId);
        return execution.result;
    };
    try {
        await applyManagedMachineEnrollmentIsolation({ target, policy, dispatch });
    } catch (error) {
        // The enrolled daemon publishes this optional capability's refusal on
        // its Machine. Authentication, admission and unknown failures still fail.
        if (!(error instanceof ManagedMachineControllerError) || error.details?.kind !== 'managedAgentIsolation'
            || error.details.phase !== 'machines.agentIsolation.preview') throw error;
    }
}

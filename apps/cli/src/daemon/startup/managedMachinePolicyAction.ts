import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps, createActionExecutor } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

/** Configured unused Stops consume rule consent; other policy effects retain shared Ask. */
export async function executeManagedMachinePolicyAction<Machine extends ManagedMachineV1>(input: Readonly<{
    machine: Machine;
    purpose: ManagedPolicyPurposeV1;
    context: ActionExecutorContext;
    serverId: string;
    runApproved(context: ActionExecutorContext): Promise<Machine>;
    createExecutor(options: Readonly<{
        hostActionApprovalLifetime: Readonly<{ operationId: string; signal: AbortSignal }>;
        managedMachineAction: NonNullable<ActionExecutorDeps['managedMachineAction']>;
    }>): Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
}>): Promise<Machine> {
    const { machine, context } = input;
    const operationId = context.operationAcceptance?.operationId;
    const signal = context.signal;
    if (!operationId || !signal || !context.operationOwnerUpdate) {
        throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
    }
    // The rule's admission is consent for its later unused Stop/Suspend.
    // Home still admits this exact policy/revision before native submission.
    if (input.purpose.kind === 'retention' && machine.retention.kind === 'unused'
        && machine.retention.effect === 'stop' && (machine.desired === 'stop' || machine.desired === 'suspend')) {
        return await input.runApproved(context);
    }
    const actionId = machine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
    const actionInput = {
        homeId: machine.homeId, managedId: machine.id, intent: machine.desired,
        when: 'now', expectedRevision: machine.intentRevision,
        ...(machine.desired === 'delete' ? { reviewedDependencies: true } : {}),
    };
    let settledMachine: Machine | undefined;
    let approvedFailure: Readonly<{ error: unknown }> | undefined;
    const result = await input.createExecutor({
        hostActionApprovalLifetime: { operationId, signal },
        managedMachineAction: async request => {
            if (request.actionId === 'machines.managed.get') {
                const target = ManagedMachineActionInputSchemasV1['machines.managed.get'].safeParse(request.input);
                if (target.success && target.data.homeId === machine.homeId && target.data.managedId === machine.id) return machine;
            }
            if (request.actionId !== actionId
                || request.context.operationAcceptance?.operationId !== operationId
                || request.context.signal !== signal
                || request.context.operationOwnerUpdate !== context.operationOwnerUpdate) {
                throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            }
            try { settledMachine = await input.runApproved(request.context); }
            catch (error) { approvedFailure = { error }; throw error; }
            return { kind: 'accepted', managedId: settledMachine.id, intentRevision: settledMachine.intentRevision, operation: { operationId } };
        },
    }).execute(actionId, actionInput, { ...context, authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: input.serverId });
    if (!result.ok) {
        if (approvedFailure) throw approvedFailure.error;
        throw Object.assign(new Error(result.error), { code: result.errorCode, actionFailure: result });
    }
    if (!settledMachine) {
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        const errorCode = approval.success ? 'approval_required' : 'admission_unavailable';
        const failure = { ok: false as const, errorCode, error: errorCode,
            ...(approval.success ? { details: { approval: approval.data } } : {}) };
        throw Object.assign(new Error(errorCode), { code: errorCode, actionFailure: failure });
    }
    return settledMachine;
}

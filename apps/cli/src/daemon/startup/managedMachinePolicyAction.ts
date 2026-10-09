import { ActionApprovalRequestCreatedResultSchema, type ActionExecutorContext, type ActionExecutorDeps, type createActionExecutor } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** The installed native owner retains its existing shared Action/Ask continuation. */
export async function executeManagedMachinePolicyAction(input: Readonly<{
    machine: ManagedMachineV1;
    context: ActionExecutorContext;
    serverId: string;
    runApproved(context: ActionExecutorContext): Promise<ManagedMachineV1>;
    createExecutor(options: Readonly<{
        hostActionApprovalLifetime: Readonly<{ operationId: string; signal: AbortSignal }>;
        managedMachineAction: NonNullable<ActionExecutorDeps['managedMachineAction']>;
    }>): Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
}>): Promise<ManagedMachineV1> {
    const { machine, context } = input;
    const operationId = context.operationAcceptance?.operationId;
    const signal = context.signal;
    if (!operationId || !signal || !context.operationOwnerUpdate) {
        throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
    }
    const actionId = machine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
    const actionInput = {
        homeId: machine.homeId, managedId: machine.id, intent: machine.desired,
        when: 'now', expectedRevision: machine.intentRevision,
        ...(machine.desired === 'delete' ? { reviewedDependencies: true } : {}),
    };
    let settledMachine: ManagedMachineV1 | undefined;
    let approvedFailure: Readonly<{ error: unknown }> | undefined;
    const result = await input.createExecutor({
        hostActionApprovalLifetime: { operationId, signal },
        managedMachineAction: async request => {
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

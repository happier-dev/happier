import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ActionExecuteFailureSchema, ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

/** The same target selection owns original admission and reviewed allocation edits. */
export function readDeploymentTargetRetentionMachineIds(actionId: string, value: unknown): readonly string[] {
    if (actionId !== 'deployments.environments.create' && actionId !== 'deployments.targets.link'
        && actionId !== 'deployments.templates.instantiate') return [];
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(value);
    if (!parsed.success) return [];
    const input = parsed.data;
    if ('mode' in input && input.mode === 'preview' || input.managedRetention === 'keep') return [];
    const machines = 'target' in input ? input.target.kind === 'new' ? [{ machineId: input.machineId }] : undefined
        : 'firstTargetLink' in input ? input.firstTargetLink?.machines
        : 'machines' in input && input.source?.kind !== 'plugin' ? input.machines : undefined;
    return machines?.map(machine => machine.machineId) ?? [];
}

/** Offer exact allocation edits through the existing parent review; never edit Account defaults. */
export async function prepareDeploymentTargetEnablementRetention(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    host: Readonly<{ homeId: string; managedMachineAction: ActionExecutorDeps['managedMachineAction'] }>,
    prepared: HostReviewedChildrenPreparationV1 | null,
): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
    const machineIds = readDeploymentTargetRetentionMachineIds(request.actionId, request.input);
    if (!machineIds.length) return prepared;
    if (!host.managedMachineAction) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    const children: HostReviewedChildrenPreparationV1['children'][number][] = [];
    for (const machineId of machineIds) {
        const loaded = await host.managedMachineAction({ actionId: 'machines.managed.list',
            input: { homeId: host.homeId, enrolledMachineId: machineId }, context: request.context,
            ...(request.context.signal ? { signal: request.context.signal } : {}) });
        const failure = ActionExecuteFailureSchema.safeParse(loaded);
        if (failure.success) return failure.data;
        const result = ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(loaded);
        const machine = result.machines.find(row => row.homeId === host.homeId && row.enrolledMachineId === machineId);
        if (!machine || machine.retention.kind === 'until-delete') continue;
        children.push({ action: 'machines.managed.retention.update', role: `target-retention:${machineId}`, input: {
            homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
        } });
    }
    if (!children.length) return prepared;
    return { children: [...(prepared?.children ?? []), ...children],
        async executeAdmittedAction(execution) {
            for (const child of children) {
                if (!execution.context.hostReviewedChild || child.input === undefined)
                    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                const result = await execution.context.hostReviewedChild.invoke({
                    action: child.action, role: child.role, input: child.input,
                });
                if (!result.ok) return result;
                // A child Ask is not an applied allocation edit. Keep its public
                // approval result instead of silently enabling the target.
                if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return result;
            }
            return prepared?.executeAdmittedAction
                ? prepared.executeAdmittedAction(execution) : execution.execute(execution.context);
        },
    };
}

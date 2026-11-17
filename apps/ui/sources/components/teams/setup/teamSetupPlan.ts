import {
    MachineSetupApplyResultV1Schema,
    waitForMachineSetupOperationV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import {
    ActionApprovalRequestCreatedResultSchema,
    type ActionApprovalRequestCreatedResult,
    type ActionExecuteFailure,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import {
    OpenProjectResultV1Schema,
    type OpenProjectInputV1,
    type OpenProjectResultV1,
} from '@happier-dev/protocol/projects/openProjectV1';

import {
    prepareMachineSetupPresetApplyInput,
    type MachineSetupPresetInput,
} from '@/components/settings/machines/managed/machineSetupApply';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type MachineSetupApplyResultV1 = ReturnType<typeof MachineSetupApplyResultV1Schema.parse>;

export type TeamSetupTarget = Readonly<{ serverId: string; homeId: string; machineId: string }>;
/** Existing Action admission binds effects to the Account that reviewed this setup. */
export type TeamSetupActionContext = ActionExecutorContext & Readonly<{ serverId: string; expectedAccountId: string }>;
export type TeamSetupRepository = Readonly<{
    id: string;
    input: Omit<OpenProjectInputV1, 'serverId' | 'machineId'>;
}>;
export type TeamSetupPlan = Readonly<{
    target: TeamSetupTarget;
    machine: Extract<MachineSetupPreparedApply, { ok: true }> | null;
    repositories: readonly Readonly<{ id: string; input: OpenProjectInputV1 }>[];
}>;
export type TeamSetupOwnerResult<T> = ActionExecuteFailure | Readonly<{
    ok: true;
    result: T | ActionApprovalRequestCreatedResult;
}>;
export type TeamSetupRunResult = Readonly<{
    machine: TeamSetupOwnerResult<MachineSetupApplyResultV1> | null;
    machineSettlement: ActionExecuteFailure | null;
    repositories: readonly Readonly<{ id: string; result: TeamSetupOwnerResult<OpenProjectResultV1> }>[];
}>;

/** The selected Machine and ordinary Project choices are the whole batch; no Team executor or progress store. */
export async function prepareTeamSetupPlan(params: Readonly<{
    executeAction: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    target: TeamSetupTarget;
    preset?: MachineSetupPresetInput;
    repositories: readonly TeamSetupRepository[];
    isCurrent: () => boolean;
}>): Promise<Readonly<{ ok: true; plan: TeamSetupPlan }> | ActionExecuteFailure | null> {
    const machine = params.preset ? await prepareMachineSetupPresetApplyInput({
        executeAction: params.executeAction,
        context: params.context,
        homeId: params.target.homeId,
        machineId: params.target.machineId,
        preset: params.preset,
        isCurrent: params.isCurrent,
    }) : null;
    if (machine && !machine.ok) return machine;
    if (params.preset && !machine) return null;
    return { ok: true, plan: {
        target: params.target,
        machine,
        repositories: params.repositories.map(repository => ({ id: repository.id, input: {
            ...repository.input, serverId: params.target.serverId, machineId: params.target.machineId,
        } })),
    } };
}

function decodeOwnerResult<T>(result: ActionExecuteResult, parse: (value: unknown) => T): TeamSetupOwnerResult<T> {
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    return { ok: true, result: approval.success ? approval.data : parse(result.result) };
}

/** Called by the surface's explicit Set up confirmation; every effect retains its existing Action admission. */
export async function runTeamSetupPlan(params: Readonly<{
    executeAction: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    plan: TeamSetupPlan;
    onMachineApplied?: (result: TeamSetupOwnerResult<MachineSetupApplyResultV1>) => void;
    onMachineSettled?: (failure: ActionExecuteFailure | null) => void;
    onRepositoryOpened?: (id: string, result: TeamSetupOwnerResult<OpenProjectResultV1>) => void;
}>): Promise<TeamSetupRunResult> {
    let machine: TeamSetupRunResult['machine'] = null;
    let machineSettlement: ActionExecuteFailure | null = null;
    if (params.plan.machine && !params.context.signal?.aborted) {
        machine = decodeOwnerResult(await params.executeAction.confirmed(
            'machines.setup.apply', params.plan.machine.input, params.context,
        ), value => MachineSetupApplyResultV1Schema.parse(value));
        params.onMachineApplied?.(machine);
        if (machine.ok && !ActionApprovalRequestCreatedResultSchema.safeParse(machine.result).success) {
            const applied = MachineSetupApplyResultV1Schema.parse(machine.result);
            const observed = await params.executeAction('action.operations.get', {
                serverId: params.plan.target.serverId, machineId: params.plan.target.machineId,
                operationId: applied.operationId, waitForTerminal: true,
            }, params.context);
            machineSettlement = observed.ok
                ? await waitForMachineSetupOperationV1(applied.operationId, async () => observed.result)
                : observed;
            params.onMachineSettled?.(machineSettlement);
        }
        // These checkouts need the selected Machine setup. Pending approval or a
        // failed prerequisite stays visible through the owner's result, without replay.
        if (!machine.ok || ActionApprovalRequestCreatedResultSchema.safeParse(machine.result).success || machineSettlement) {
            return { machine, machineSettlement, repositories: [] };
        }
    }
    const repositories: TeamSetupRunResult['repositories'][number][] = [];
    for (const repository of params.plan.repositories) {
        if (params.context.signal?.aborted) break;
        const result = decodeOwnerResult(await params.executeAction.confirmed(
            'projects.open', repository.input, params.context,
        ), value => OpenProjectResultV1Schema.parse(value));
        repositories.push({ id: repository.id, result });
        params.onRepositoryOpened?.(repository.id, result);
    }
    return { machine, machineSettlement, repositories };
}

/** Opening an editable composer is a separate person action, never a side effect of joining or setup. */
export async function openTeamSetupFirstTask(params: Readonly<{
    executeAction: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    project: Extract<OpenProjectResultV1, { kind: 'opened' }>;
    machineId: string;
    prompt: string;
}>): Promise<ActionExecuteResult> {
    return params.executeAction('session.authoring.open', { seed: {
        prompt: params.prompt,
        placement: { kind: 'exactTarget', serverId: params.project.workspace.serverId,
            machineId: params.machineId, directory: params.project.directory },
    } }, params.context);
}

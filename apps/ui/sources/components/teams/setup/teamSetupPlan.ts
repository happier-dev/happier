import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { OpenProjectInputV1, OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import {
    TEAM_SETUP_RUN_ACTION_ID_V1, TeamSetupBatchResultV1Schema, type TeamSetupBatchResultV1,
} from '@happier-dev/protocol/teams';

import {
    prepareMachineSetupPresetApplyInput,
    type MachineSetupPresetInput,
} from '@/components/settings/machines/managed/machineSetupApply';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';

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
export type TeamSetupRunResult = Readonly<TeamSetupBatchResultV1>;

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
    return { ok: true, plan: buildTeamSetupPlan(params.target, machine, params.repositories) };
}

/** Attach the person's repository choices to the Machine plan already shown in review. */
export function buildTeamSetupPlan(
    target: TeamSetupTarget,
    machine: TeamSetupPlan['machine'],
    repositories: readonly TeamSetupRepository[],
): TeamSetupPlan {
    return { target, machine, repositories: repositories.map(repository => ({ id: repository.id, input: {
        ...repository.input, serverId: target.serverId, machineId: target.machineId,
    } })) };
}

/** Joined Setup has already presented the checkboxes and the Set up confirmation. */
export async function runTeamSetupPlan(params: Readonly<{
    executeAction: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    plan: TeamSetupPlan;
    actionRequestId?: string;
    onMachineApplied?: (result: NonNullable<TeamSetupRunResult['machine']>) => void;
    onRepositoryOpening?: (id: string) => void;
}>): Promise<TeamSetupRunResult> {
    const { plan, context, actionRequestId } = params;
    const execution = await params.executeAction.confirmed(TEAM_SETUP_RUN_ACTION_ID_V1, {
        ...plan.target,
        ...(plan.machine ? { machine: plan.machine.input } : {}),
        repositories: plan.repositories,
    }, {
        ...context,
        ...(actionRequestId ? { actionRequestId } : {}),
        onTeamSetupBatchProgress: event => {
            if (event.kind === 'machineApplied') params.onMachineApplied?.(event.result);
            else params.onRepositoryOpening?.(event.id);
        },
    });
    return execution.ok ? TeamSetupBatchResultV1Schema.parse(execution.result)
        : TeamSetupBatchResultV1Schema.parse({ completed: false, machine: null, machineSettlement: execution, repositories: [] });
}

/** Opening an editable composer is a separate person action, never a side effect of joining or setup. */
export async function openTeamSetupFirstTask(params: Readonly<{
    executeAction: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    lifetime: ServerAccountScopeLifetime;
    project: Extract<OpenProjectResultV1, { kind: 'opened' }>;
    machineId: string;
    prompt: string;
}>) {
    return openSessionAuthoringAction(buildTeamSetupFirstTaskInput(params), params.lifetime, {
        signal: params.context.signal,
        executeAction: (actionId, input) => params.executeAction(actionId, input, params.context),
    });
}

/** The composer seed for one opened checkout; a blank prompt opens an empty draft (the seed owner refuses blank text). */
export function buildTeamSetupFirstTaskInput(params: Readonly<{
    project: Extract<OpenProjectResultV1, { kind: 'opened' }>;
    machineId: string;
    prompt: string;
}>) {
    return { seed: {
        ...(params.prompt.trim() ? { prompt: params.prompt } : {}),
        placement: { kind: 'exactTarget' as const, serverId: params.project.workspace.serverId,
            machineId: params.machineId, directory: params.project.directory },
    } };
}

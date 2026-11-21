import type { ManagedMachineV1, ManagedMachineRefV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionAdmittedExecutionV1, ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure, ActionExecuteResult, ActionMachineRuntimeDemandV1, ActionPreparedMachineTargetV1, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_POWER_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { resolveMachineWakeNativeIntentV1, resolveManagedMachineRuntimeV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { prepareManagedPowerProvisionerAdmissionV1, type ManagedProvisionerSelectionRead } from './provisioners.js';

export type ManagedWakePreparationReads = Readonly<{
    /** Identity of the installed in-process daemon, which already supplies this runtime. */
    localMachineId?: string;
    /** The target's Home owns enrollment; null positively identifies an ordinary Machine. */
    readMachineTarget(machineId: string, context: ActionExecutorContext): Promise<Readonly<{
        reachable: boolean; managedMachineRef: ManagedMachineRefV1 | null;
    }> | ActionExecuteFailure>;
    readSessionMachineId(target: Extract<ActionMachineRuntimeDemandV1['target'], { kind: 'session' }>,
        context: ActionExecutorContext): Promise<string | null | ActionExecuteFailure>;
    readManagedMachine(input: ManagedMachineRefV1,
        context: ActionExecutorContext, runtime?: 'native'): Promise<ManagedMachineV1 | null | ActionExecuteFailure>;
    readSelectedProvisioners?: ManagedProvisionerSelectionRead;
}>;

type ManagedWakePowerInput = Extract<ManagedMachineActionInputV1<typeof MANAGED_POWER_SET_ACTION_ID_V1>, { when: 'now' }>;
type ManagedWakeTarget = ManagedMachineRefV1 & Readonly<{ powerInput?: ManagedWakePowerInput }>;

/** Invocation-private placement and reviewed power choice, captured only by preparation's closure. */
export type ManagedMachinePreparedRuntime =
    | (ActionPreparedMachineTargetV1 & Readonly<{ managed?: ManagedWakeTarget }>)
    | Readonly<{ native: ManagedWakeTarget }>;

export type ManagedMachineRuntimeDemandExecution = ActionAdmittedExecutionV1 & Readonly<{
    machineRuntime: ManagedMachinePreparedRuntime;
}>;

/** The same concrete operand is reviewed at preparation and invoked by execution. */
export function managedMachineWakePowerInput(machine: ManagedMachineV1): ManagedWakePowerInput {
    const intent = resolveMachineWakeNativeIntentV1(machine.observation?.power,
        machine.reviewedFacts?.retentionCapabilities.supportedIntents ?? ['start']);
    if (!intent) throw new ManagedMachineControllerError('provider_unavailable');
    return { homeId: machine.homeId, managedId: machine.id, when: 'now', expectedRevision: machine.intentRevision,
        intent };
}

/** Domain preparation consumes the generic admission's demand; it never issues native work. */
export async function prepareManagedMachineWakeChildren(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    reads: ManagedWakePreparationReads,
    executePrepared?: (request: ManagedMachineRuntimeDemandExecution) => Promise<ActionExecuteResult>,
): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
    const demand = request.machineRuntimeDemand;
    if (!demand) return null;
    if (demand.target.kind === 'managed-machine') {
        const { homeId, managedId } = demand.target;
        const target = { homeId, managedId };
        const machine = await reads.readManagedMachine(target, request.context, 'native');
        if (machine && 'ok' in machine) return machine;
        if (!machine) return { ok: false, errorCode: 'managed_not_found', error: 'managed_not_found' };
        const runtime = resolveManagedMachineRuntimeV1(machine, null);
        if (runtime.ready) return { children: [] };
        if (!runtime.available || !runtime.wakeState)
            return { ok: false, errorCode: 'native_resource_unavailable', error: 'native_resource_unavailable' };
        return prepareManagedWakePlan(reads, machine,
            runtime.inspectionRequired ? managedMachineWakePowerInput(machine) : undefined,
            managed => ({ native: managed }), executePrepared);
    }
    const machineId = demand.target.kind === 'machine' ? demand.target.machineId
        : await reads.readSessionMachineId(demand.target, request.context);
    if (machineId === null || typeof machineId !== 'string') return machineId;
    // An installed local target needs no wake or second managed-Action admission.
    if (machineId === reads.localMachineId) return null;
    const target = await reads.readMachineTarget(machineId, request.context);
    if ('ok' in target) return target;
    // Home owns wake after input admission.
    if (demand.activation === 'accepted-input') return null;
    if (!target.managedMachineRef) return {
        children: [],
        executeAdmittedAction: execution => execution.execute(execution.context,
            { machineId, ...(demand.serverId ? { serverId: demand.serverId } : {}) }),
    };
    const machine = await reads.readManagedMachine(target.managedMachineRef, request.context);
    if (machine && 'ok' in machine) return machine;
    if (!machine) return { children: [],
        ...(executePrepared ? { executeAdmittedAction: (execution: ActionAdmittedExecutionV1) => executePrepared({
            ...execution, machineRuntime: { machineId, ...(demand.serverId ? { serverId: demand.serverId } : {}) } }) } : {}),
    };
    const powerInput = resolveManagedMachineRuntimeV1(machine, machineId, target.reachable).inspectionRequired
        ? managedMachineWakePowerInput(machine) : undefined;
    return prepareManagedWakePlan(reads, machine, powerInput, managed => ({
        machineId, ...(demand.serverId ? { serverId: demand.serverId } : {}), managed,
    }), executePrepared);
}

async function prepareManagedWakePlan(
    reads: ManagedWakePreparationReads,
    machine: ManagedMachineV1,
    powerInput: ManagedWakePowerInput | undefined,
    prepareTarget: (managed: ManagedWakeTarget) => ManagedMachinePreparedRuntime,
    executePrepared: ((request: ManagedMachineRuntimeDemandExecution) => Promise<ActionExecuteResult>) | undefined,
): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> {
    const providerRoles = powerInput ? await prepareManagedPowerProvisionerAdmissionV1(machine,
        reads.readSelectedProvisioners ?? (async () => null)) : null;
    if (providerRoles && 'ok' in providerRoles) return providerRoles;
    const machineRuntime = prepareTarget({ homeId: machine.homeId, managedId: machine.id,
        ...(powerInput ? { powerInput } : {}) });
    return { children: powerInput ? [{ action: MANAGED_POWER_SET_ACTION_ID_V1, role: 'managed-wake', input: powerInput },
        ...(providerRoles?.children ?? [])] : [],
        ...(executePrepared ? { executeAdmittedAction: (execution: ActionAdmittedExecutionV1) => executePrepared({
            ...execution, machineRuntime }) } : {}) };
}

export type ManagedMachineWakeThenRun<T> = Readonly<{
    powerInput?: ManagedWakePowerInput;
    signal?: AbortSignal;
    power(input: ManagedWakePowerInput): Promise<void>;
    waitUntilReady(signal?: AbortSignal): Promise<void>;
    run(): Promise<T>;
}>;

/** Explicit execution only; passive readers never enter this owner. */
export async function executeManagedMachineWakeThenRun<T>(input: ManagedMachineWakeThenRun<T>): Promise<T> {
    input.signal?.throwIfAborted();
    if (input.powerInput) await input.power(input.powerInput);
    await input.waitUntilReady(input.signal);
    input.signal?.throwIfAborted();
    return input.run();
}

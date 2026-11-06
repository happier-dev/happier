import type { ManagedMachineRefV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionAdmittedExecutionV1, ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure, ActionExecuteResult, ActionMachineRuntimeDemandV1, ActionPreparedMachineTargetV1, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveMachineWakeNativeIntentV1, isManagedMachineWakeInspectionRequiredV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { prepareManagedPowerProvisionerAdmissionV1, type ManagedProvisionerSelectionRead } from './provisioners.js';

/** A positively unavailable resource cannot become ready by observing its daemon. */
export function assertManagedMachineRuntimeAvailable(machine: Pick<ManagedMachineV1, 'creationState' | 'allocation' | 'observation'>): void {
    if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent'
        || machine.observation?.availability === 'absent' || machine.observation?.storage === 'lost') {
        throw new ManagedMachineControllerError('native_resource_unavailable');
    }
}

/** Native power and the existing scoped daemon observation are independent facts. */
export function isManagedMachineExecutionReady(machine: Pick<ManagedMachineV1, 'creationState' | 'allocation' | 'observation'>,
    machineReachable: boolean): boolean {
    return machine.creationState === 'active' && machine.allocation !== 'confirmed-absent'
        // A reachable daemon proves readiness through failed native Inspect,
        // unless the provider positively reports loss or a parked Machine.
        && (machine.observation?.availability === 'present' || machine.observation?.availability === 'unavailable')
        && machine.observation.power !== 'stopped' && machine.observation.power !== 'suspended'
        && machine.observation.storage !== 'lost' && machineReachable;
}

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
        context: ActionExecutorContext): Promise<ManagedMachineV1 | null | ActionExecuteFailure>;
    readSelectedProvisioners?: ManagedProvisionerSelectionRead;
}>;

type ManagedWakePowerInput = Extract<ManagedMachineActionInputV1<'machines.managed.power.set'>, { when: 'now' }>;

/** Invocation-private placement and reviewed power choice, captured only by preparation's closure. */
export type ManagedMachinePreparedRuntime = ActionPreparedMachineTargetV1 & Readonly<{
    managed?: Readonly<{ homeId: string; managedId: string; powerInput?: ManagedWakePowerInput }>;
}>;

export type ManagedMachineRuntimeDemandExecution = ActionAdmittedExecutionV1 & Readonly<{
    machineRuntime: ManagedMachinePreparedRuntime;
}>;

/** The same concrete operand is reviewed at preparation and invoked by execution. */
export function managedMachineWakePowerInput(machine: ManagedMachineV1): Extract<ManagedMachineActionInputV1<'machines.managed.power.set'>, { when: 'now' }> {
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
    const machineId = demand.target.kind === 'machine' ? demand.target.machineId
        : await reads.readSessionMachineId(demand.target, request.context);
    if (machineId === null || typeof machineId !== 'string') return machineId;
    // An installed local target needs no wake or second managed-Action admission.
    if (machineId === reads.localMachineId) return null;
    const target = await reads.readMachineTarget(machineId, request.context);
    if ('ok' in target) return target;
    if (!target.managedMachineRef) return null;
    const machine = await reads.readManagedMachine(target.managedMachineRef, request.context);
    if (machine && 'ok' in machine) return machine;
    const powerInput = machine && isManagedMachineWakeInspectionRequiredV1(machine, machineId, target.reachable)
        ? managedMachineWakePowerInput(machine) : undefined;
    const providerRoles = machine && powerInput ? await prepareManagedPowerProvisionerAdmissionV1(machine,
        reads.readSelectedProvisioners ?? (async () => null)) : null;
    if (providerRoles && 'ok' in providerRoles) return providerRoles;
    const machineRuntime: ManagedMachinePreparedRuntime = { machineId, ...(demand.serverId ? { serverId: demand.serverId } : {}),
        ...(machine ? { managed: { homeId: machine.homeId, managedId: machine.id, ...(powerInput ? { powerInput } : {}) } } : {}) };
    return { children: powerInput ? [{ action: 'machines.managed.power.set', role: 'managed-wake', input: powerInput },
        ...(providerRoles?.children ?? [])] : [],
        ...(executePrepared && demand.activation !== 'accepted-input' ? { executeAdmittedAction: (execution: ActionAdmittedExecutionV1) => executePrepared({
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

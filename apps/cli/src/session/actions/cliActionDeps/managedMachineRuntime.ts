import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import { UpdateContainerSchema, EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { assertManagedMachineRuntimeAvailable, executeManagedMachineWakeThenRun, isManagedMachineExecutionReady,
    ManagedMachineControllerError, type ManagedMachineRuntimeDemandExecution, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { observeSessionSocketEvents } from '@/session/transport/socket/sessionSocketAgentState';
import { waitForChange } from '@/utils/async/waitForChange';
import type { StoredCredentials } from '@/persistence';

export type CliManagedMachineRuntimeAccount = Readonly<{ token: string; credentials?: StoredCredentials | null; serverUrl: string }>;

/** Exact Home presence is the same fact used by ordinary CLI Machine selection. */
export async function readCliManagedMachineTarget(machineId: string, context: ActionExecutorContext,
    account: CliManagedMachineRuntimeAccount): ReturnType<ManagedWakePreparationReads['readMachineTarget']> {
    try {
        const [machine] = await listCurrentAccountMachines({ token: account.token,
            ...(account.credentials ? { credentials: account.credentials } : {}),
            ...(context.externalActionExecutionAuthorization ? { authorization: context.externalActionExecutionAuthorization } : {}),
            serverHttpBaseUrl: account.serverUrl, projection: 'hostFacts', machineIds: [machineId], signal: context.signal });
        if (!machine) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        return { reachable: isMachineReachableV1({ machine }), managedMachineRef: machine.managedMachineRef };
    } catch {
        const code = context.signal?.aborted ? 'cancelled' : 'machine_inventory_unavailable';
        return { ok: false, errorCode: code, error: code };
    }
}

/** The admitted original observes its exact guest; Account pushes only invalidate its reads. */
export async function executeCliManagedMachineRuntimeDemand(request: ManagedMachineRuntimeDemandExecution,
    account: CliManagedMachineRuntimeAccount, reads: ManagedWakePreparationReads): Promise<ActionExecuteResult> {
    const { machineId, serverId, managed } = request.machineRuntime;
    const run = () => request.execute(request.context, { machineId, ...(serverId ? { serverId } : {}) });
    if (!managed) return run();
    const signal = request.context.signal;
    let changed = false;
    let failure: unknown;
    const listeners = new Set<() => void>();
    const notify = () => { changed = true; for (const listener of [...listeners]) listener(); };
    const observation = observeSessionSocketEvents({ token: account.token, serverUrl: account.serverUrl, scope: 'user' }, {
        onConnected: notify,
        onError: error => { failure = error; notify(); },
        onUpdate: raw => {
            const parsed = UpdateContainerSchema.safeParse(raw);
            if (!parsed.success) return;
            const body = parsed.data.body;
            if (body.t === 'update-machine' && body.machineId === machineId
                || body.t === 'account-change' && (!body.entityIds
                    || body.entityIds.includes(managed.managedId) || body.entityIds.includes(machineId))) notify();
        },
        onEphemeral: raw => {
            const parsed = EphemeralUpdateSchema.safeParse(raw);
            if (parsed.success && parsed.data.type === 'machine-activity' && parsed.data.id === machineId) notify();
        },
    });
    try {
        return await executeManagedMachineWakeThenRun({ powerInput: managed.powerInput, signal, run,
            power: async input => {
                const children = request.context.hostReviewedChild;
                if (!children) throw new ManagedMachineControllerError('managed_power_required');
                const result = await children.invoke({ action: 'machines.managed.power.set', role: 'managed-wake', input });
                if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, 'machines.managed.power.set');
                const intent = ManagedIntentResultSchema.parse(result.result);
                if (intent.kind !== 'accepted') throw new ManagedMachineControllerError(intent.kind === 'conflict' ? 'intent_conflict' : intent.code);
            },
            waitUntilReady: async () => {
                for (;;) {
                    signal?.throwIfAborted();
                    if (failure !== undefined) throw failure;
                    // Clear before reading so a push during either read remains latched.
                    changed = false;
                    const [machine, target] = await Promise.all([
                        reads.readManagedMachine({ homeId: managed.homeId, managedId: managed.managedId }, request.context),
                        reads.readMachineTarget(machineId, request.context),
                    ]);
                    if ('ok' in target) throw ManagedMachineControllerError.fromActionFailure(target, request.actionId);
                    if (machine && 'ok' in machine) throw ManagedMachineControllerError.fromActionFailure(machine, request.actionId);
                    if (!machine) throw new ManagedMachineControllerError('managed_not_found');
                    assertManagedMachineRuntimeAvailable(machine);
                    if (isManagedMachineExecutionReady(machine, target.reachable)) return;
                    await waitForChange({ signal, hasChanged: () => changed || failure !== undefined,
                        subscribe: wake => { listeners.add(wake); return () => { listeners.delete(wake); }; } });
                }
            },
        });
    } finally {
        await observation.dispose();
    }
}

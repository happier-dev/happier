import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { assertManagedMachineRuntimeAvailable, executeManagedMachineWakeThenRun, isManagedMachineExecutionReady, ManagedMachineControllerError, waitForChangeOrDeadline, type ManagedMachinePreparedRuntime, type ManagedMachineRuntimeDemandExecution } from '@happier-dev/cli-common/machines/managed';
import { retainManagedMachineInventory, type ManagedMachineInventoryEntry } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { isMachineReachable, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { subscribeMachineActivity } from '@/sync/domains/machines/machineActivity';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { requireActionSuccess } from './frontDoorRuntimeActionExecutor';

/** Bound once at generic post-admission dispatch, never at a passive reader or raw RPC. */
export async function executeUiManagedMachineRuntimeDemand(request: ManagedMachineRuntimeDemandExecution,
    account: LazyActionAccountContext | undefined): Promise<ActionExecuteResult> {
    if (!account?.serverIdentityId) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    const { machineId, serverId } = request.machineRuntime;
    return executeUiManagedMachineWakeThenRun({ account, machineRuntime: request.machineRuntime,
        context: request.context, run: () => request.execute(request.context, { machineId, ...(serverId ? { serverId } : {}) }) });
}

export type UiManagedMachineWakeThenRun<T> = Readonly<{
    account: LazyActionAccountContext;
    machineRuntime: ManagedMachinePreparedRuntime;
    context: ActionExecutorContext;
    run(): Promise<T>;
}>;

/** Consumed only by an admitted explicit execution entry. */
export async function executeUiManagedMachineWakeThenRun<T>(input: UiManagedMachineWakeThenRun<T>): Promise<T> {
    const { machineId, managed } = input.machineRuntime;
    if (!managed) return input.run();
    return withActionAccountRequestSignal(input.account, input.context.signal, async signal => {
        input.account.assertCurrent();
        let changed: (() => void) | undefined;
        const notify = () => changed?.();
        const readGuest = () => resolveServerScopedMachine(storage.getState(), input.account.serverId, machineId);
        let guest: Machine | null = null;
        let stopActivity: (() => void) | undefined;
        const observeGuest = () => {
            const next = readGuest();
            if (next !== guest) {
                stopActivity?.();
                guest = next;
                stopActivity = next ? subscribeMachineActivity(next, notify) : undefined;
            }
            notify();
        };
        let latest: ManagedMachineInventoryEntry | undefined;
        const inventory = retainManagedMachineInventory(input.account.accountLifetime, entry => { latest = entry; notify(); },
            { managedId: managed.managedId });
        const stopGuest = subscribeMachineUpdates((serverId, ids) => {
            if (areServerProfileIdentifiersEquivalent(serverId, input.account.serverId) && ids.includes(machineId)) observeGuest();
        });
        const stopReachability = subscribeMachineRequestReachability(notify, {
            scope: input.account.accountLifetime.scope, machineId,
        });
        observeGuest();
        const waitForChange = (waiting: AbortSignal) => new Promise<void>(resolve => {
            const settle = () => {
                changed = undefined;
                waiting.removeEventListener('abort', settle);
                resolve();
            };
            changed = settle;
            waiting.addEventListener('abort', settle, { once: true });
            if (waiting.aborted) settle();
        });
        const read = async () => {
            for (;;) {
                signal?.throwIfAborted();
                const entry = latest;
                if (entry && entry.status !== 'loading' && entry.status !== 'ready') {
                    throw new ManagedMachineControllerError(entry.errorCode ?? 'managed_request_failed');
                }
                if (entry?.status === 'ready') {
                    const machine = inventory.getMachine(managed.managedId);
                    if (!machine) throw new ManagedMachineControllerError('managed_not_found');
                    assertManagedMachineRuntimeAvailable(machine);
                    const currentGuest = readGuest();
                    if (isManagedMachineExecutionReady(machine, Boolean(currentGuest
                        && isMachineReachable(input.account.accountLifetime.scope, currentGuest)))) return machine;
                }
                if (await waitForChangeOrDeadline({ signal, waitForChange }) === 'aborted') signal?.throwIfAborted();
            }
        };
        try {
            return await executeManagedMachineWakeThenRun({ powerInput: managed.powerInput, signal,
                power: async powerInput => {
                    const children = input.context.hostReviewedChild;
                    if (!children) throw new ManagedMachineControllerError('managed_power_required');
                    const result = await children.invoke({ action: 'machines.managed.power.set', role: 'managed-wake',
                        input: powerInput });
                    requireActionSuccess(result);
                    const intent = ManagedIntentResultSchema.parse(result.result);
                    if (intent.kind !== 'accepted') throw new ManagedMachineControllerError(intent.kind === 'conflict' ? 'intent_conflict' : intent.code);
                },
                waitUntilReady: async () => { await read(); }, run: input.run,
            });
        } finally {
            inventory.dispose(); stopGuest(); stopReachability(); stopActivity?.();
        }
    });
}

import {
    MachineGuardViewV1Schema, MachineGuardWatchInputV1Schema, MachineGuardWatchResultV1Schema,
    MachineGuardActivityWatchInputV1Schema, MachineGuardActivityWatchResultV1Schema,
    type MachineGuardActivityWatchResultV1,
    type MachineGuardViewV1, type MachineGuardWatchResultV1,
} from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { MachineGuardActivityListV1Schema, type MachineGuardActivityListV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { MachineGuardActionId } from '@happier-dev/protocol/machines/guard/actionIdsV1';
import { MachineGuardKeepRunningResultV1Schema } from '@happier-dev/protocol/actions/specs/machineGuard';
import { createRpcCallError, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import type { MachineDaemonReadKey } from '../useMachineDaemonReadTarget';
import { projectMachineDaemonRpcFailure, type MachineDaemonRpcFailure } from '../machineDaemonRpcErrors';

/**
 * The Guard's reads and its two person-facing writes, through the published Actions (lane 50a's stable
 * contract): `machines.guard.get` and the Activity list/Undo/Keep running go through the front door so
 * approval and audit stay the Actions'; the parked Guard and Activity watches are independent read transports.
 */

export type MachineGuardReadInput = MachineDaemonReadKey & Readonly<{ signal?: AbortSignal }>;
export type MachineGuardActivityQuery = Readonly<{ range: 'today' | '7d' | '30d'; filter: 'all' | 'stopped' | 'cleaned_up' | 'needs_look' }>;
/** Guard's preview and the Activity page open on the same history, before the person changes filters. */
export const DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY = { range: '7d', filter: 'all' } as const satisfies MachineGuardActivityQuery;
export type MachineGuardResult<T> = Readonly<{ ok: true; value: T }> | MachineDaemonRpcFailure;
export type MachineGuardClients = Readonly<{
    viewClient: (input: MachineGuardReadInput) => Promise<MachineGuardResult<MachineGuardViewV1>>;
    watchClient: (input: MachineGuardReadInput & Readonly<{ since?: number }>) => Promise<MachineGuardResult<MachineGuardWatchResultV1>>;
    activityClient: (input: MachineGuardReadInput & MachineGuardActivityQuery) => Promise<MachineGuardResult<MachineGuardActivityListV1>>;
    activityWatchClient: (input: MachineGuardReadInput & MachineGuardActivityQuery & Readonly<{ since?: number }>) => Promise<MachineGuardResult<MachineGuardActivityWatchResultV1>>;
}>;

async function result<T>(input: Readonly<{ signal?: AbortSignal }>, request: () => Promise<unknown>,
    parse: (raw: unknown) => { success: true; data: T } | { success: false }, settledEffect = false): Promise<MachineGuardResult<T>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const raw = await request();
        // Captured Action reads enforce disclosure custody. The transport owns
        // cancellation settlement; a received effect acknowledgement stays true.
        if (!settledEffect && input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (isRpcMethodNotFoundResult(raw)) return { ok: false, reason: 'older_happier' };
        const parsed = parse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return projectMachineDaemonRpcFailure(error);
    }
}

let actionExecute: FrontDoorActionExecute | undefined;
async function execute(input: MachineGuardReadInput, actionId: MachineGuardActionId, extra: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
    const outcome = await actionExecute(actionId, {
        machineId: input.machineId, ...(input.serverId ? { serverId: input.serverId } : {}), ...extra,
    }, { surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    if (!outcome.ok) throw createRpcCallError({ error: outcome.error, errorCode: outcome.errorCode, failureCause: outcome.failureCause });
    return outcome.result;
}

export function fetchMachineGuardViewViaAction(input: MachineGuardReadInput): Promise<MachineGuardResult<MachineGuardViewV1>> {
    return result(input, () => execute(input, 'machines.guard.get'), raw => MachineGuardViewV1Schema.safeParse(raw));
}

export function watchMachineGuardViaMachineRpc(input: MachineGuardReadInput & Readonly<{ since?: number }>): Promise<MachineGuardResult<MachineGuardWatchResultV1>> {
    const payload = MachineGuardWatchInputV1Schema.parse({ machineId: input.machineId,
        ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.since === undefined ? {} : { since: input.since }) });
    return result(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        ...(input.expectedAccountId ? { accountId: input.expectedAccountId } : {}), method: RPC_METHODS.DAEMON_GUARD_WATCH,
        payload, ...(input.signal ? { signal: input.signal } : {}) }),
    raw => MachineGuardWatchResultV1Schema.safeParse(raw));
}

export function fetchMachineGuardActivityViaAction(input: MachineGuardReadInput & MachineGuardActivityQuery): Promise<MachineGuardResult<MachineGuardActivityListV1>> {
    return result(input, () => execute(input, 'machines.guard.activity.list', { range: input.range, filter: input.filter }),
        raw => MachineGuardActivityListV1Schema.safeParse(raw));
}

export function watchMachineGuardActivityViaMachineRpc(input: MachineGuardReadInput & MachineGuardActivityQuery & Readonly<{ since?: number }>): Promise<MachineGuardResult<MachineGuardActivityWatchResultV1>> {
    const payload = MachineGuardActivityWatchInputV1Schema.parse({ machineId: input.machineId, range: input.range, filter: input.filter,
        ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.since === undefined ? {} : { since: input.since }) });
    return result(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        ...(input.expectedAccountId ? { accountId: input.expectedAccountId } : {}), method: RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH,
        payload, ...(input.signal ? { signal: input.signal } : {}) }),
    raw => MachineGuardActivityWatchResultV1Schema.safeParse(raw));
}

/** Undo runs the captured original Action on the machine; its own result (or approval) comes back as is. */
export async function undoMachineGuardActivityViaAction(input: MachineGuardReadInput & Readonly<{ entryId: string }>): Promise<MachineGuardResult<unknown>> {
    return result(input, () => execute(input, 'machines.guard.activity.undo', { entryId: input.entryId }), raw => ({ success: true as const, data: raw }), true);
}

export function keepMachineGuardWorkRunningViaAction(input: MachineGuardReadInput & (Readonly<{ sessionId: string }> | Readonly<{ terminalKey: string }>)) {
    const target = 'sessionId' in input ? { sessionId: input.sessionId } : { terminalKey: input.terminalKey };
    return result(input, () => execute(input, 'machines.guard.idleStop.keepRunning', target), raw => MachineGuardKeepRunningResultV1Schema.safeParse(raw), true);
}

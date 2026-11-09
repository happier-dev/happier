import {
    MachineVitalsGetInputV1Schema,
    MachineVitalsHistoryGetInputV1Schema,
    MachineVitalsSnapshotV1Schema,
    MachineVitalsWatchInputV1Schema,
    MachineVitalsWatchResultV1Schema,
    type MachineVitalsSnapshotV1,
    type MachineVitalsWatchResultV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { MachineVitalsHistoryV1Schema, type MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { createRpcCallError, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachineVitalsActionId } from '@happier-dev/protocol/actions/specs/machineVitals';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveMachineDaemonReadServerId } from '../useMachineDaemonReadTarget';
import { projectMachineDaemonRpcFailure, type MachineDaemonRpcFailure } from '../machineDaemonRpcErrors';

export type MachineResourceKey = Readonly<{ machineId: string; serverId?: string | null; expectedAccountId?: string | null; daemonStateVersion?: number | null }>;
export type MachineVitalsView = 'summary' | 'overview';
export type MachineVitalsRange = MachineVitalsHistoryV1['range'];
export type MachineVitalsReadInput = MachineResourceKey & Readonly<{ view: MachineVitalsView; signal?: AbortSignal }>;
export type MachineVitalsHistoryReadInput = MachineResourceKey & Readonly<{ range: MachineVitalsRange; signal?: AbortSignal }>;
export type MachineVitalsWatchInput = MachineVitalsReadInput & Readonly<{ sinceSampledAt?: number; onDispatched?: () => void }>;
export type MachineResourceRpcResult<T> = Readonly<{ ok: true; value: T }> | MachineDaemonRpcFailure;

/** One-shot pointer/focus reads capture the same credential-owned key as mounted daemon readers. */
export async function resolveMachineResourceKey(input: MachineResourceKey): Promise<MachineResourceKey | null> {
    const serverId = resolveMachineDaemonReadServerId(input.serverId);
    const resolution = await resolveServerCredentialAccountScope(serverId);
    if (resolution.kind !== 'bound' || (input.expectedAccountId && input.expectedAccountId !== resolution.scope.accountId)) return null;
    return { ...input, serverId: resolution.scope.serverId, expectedAccountId: resolution.scope.accountId };
}

let actionExecute: FrontDoorActionExecute | undefined;
async function execute(input: MachineResourceKey & Readonly<{ signal?: AbortSignal }>, actionId: MachineVitalsActionId, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
    const outcome = await actionExecute(actionId, { ...payload, ...(input.serverId ? { serverId: input.serverId } : {}) }, {
        surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}), ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!outcome.ok) throw createRpcCallError({ error: outcome.error, errorCode: outcome.errorCode, failureCause: outcome.failureCause });
    return outcome.result;
}

async function read<T>(input: MachineResourceKey & Readonly<{ signal?: AbortSignal }>, request: () => Promise<unknown>, parse: (raw: unknown) => { success: true; data: T } | { success: false }): Promise<MachineResourceRpcResult<T>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const raw = await request();
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (isRpcMethodNotFoundResult(raw)) return { ok: false, reason: 'older_happier' };
        const parsed = parse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return projectMachineDaemonRpcFailure(error);
    }
}

export function fetchMachineVitalsViaMachineRpc(input: MachineVitalsReadInput): Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>> {
    const payload = MachineVitalsGetInputV1Schema.parse({ machineId: input.machineId, view: input.view });
    return read(input, () => execute(input, 'machines.vitals.get', payload), (raw) => MachineVitalsSnapshotV1Schema.safeParse(raw));
}

export function watchMachineVitalsViaMachineRpc(input: MachineVitalsWatchInput): Promise<MachineResourceRpcResult<MachineVitalsWatchResultV1>> {
    const payload = MachineVitalsWatchInputV1Schema.parse({ machineId: input.machineId, view: input.view,
        ...(input.sinceSampledAt === undefined ? {} : { sinceSampledAt: input.sinceSampledAt }) });
    return read(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        ...(input.expectedAccountId ? { accountId: input.expectedAccountId } : {}),
        method: RPC_METHODS.DAEMON_VITALS_WATCH, payload, ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onDispatched ? { onDispatched: input.onDispatched } : {}) }), (raw) => MachineVitalsWatchResultV1Schema.safeParse(raw));
}

export function fetchMachineVitalsHistoryViaMachineRpc(input: MachineVitalsHistoryReadInput): Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>> {
    const payload = MachineVitalsHistoryGetInputV1Schema.parse({ machineId: input.machineId, range: input.range });
    return read(input, () => execute(input, 'machines.vitals.history.get', payload), (raw) => MachineVitalsHistoryV1Schema.safeParse(raw));
}

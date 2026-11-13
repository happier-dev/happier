import { MachineScheduledResultV1Schema, type MachineScheduledInputV1, type MachineScheduledResultV1 } from '@happier-dev/protocol/machines/scheduled/scheduledV1';
import type { MachineScheduledActionId } from '@happier-dev/protocol/machines/scheduled/actionIdsV1';
import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { subscribeLocalServiceCredentialRetirement } from '@/sync/domains/local/services/inventory/sharedStore';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type MachineScheduledKey = Omit<MachineScheduledInputV1, 'sinceRevision' | 'refresh'> & Readonly<{ accountId: string; credentialKey: string }>;
type Snapshot = Extract<MachineScheduledResultV1, { kind: 'snapshot' }>;
export type MachineScheduledState = Readonly<{ status: 'loading' | 'ready' | 'error'; snapshot: Snapshot | null; errorCode?: string }>;
export type MachineScheduledClient = (actionId: MachineScheduledActionId, input: MachineScheduledKey & Readonly<{ sinceRevision?: number; refresh?: boolean }>, signal?: AbortSignal) => Promise<MachineScheduledResultV1>;
const EMPTY: MachineScheduledState = { status: 'loading', snapshot: null };
let execute: FrontDoorActionExecute | undefined;
const client: MachineScheduledClient = async (id, input, signal) => {
  const { accountId, credentialKey: _credentialKey, ...payload } = input;
  execute ??= (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
  const result = await execute(id, payload, { surface: 'ui', serverId: input.serverId, expectedAccountId: accountId, ...(signal ? { signal } : {}) });
  if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
  return MachineScheduledResultV1Schema.parse(result.result);
};
const failure = (state: MachineScheduledState, error: unknown): MachineScheduledState => ({ ...state, status: 'error',
  errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'request_failed' });
/** Native schedules share the incumbent demand, recovery and credential-retirement lifecycle. */
export function createMachineScheduledStore(request: MachineScheduledClient = client) {
  const apply = (state: MachineScheduledState, snapshot: Snapshot): MachineScheduledState => {
    const next = retainDeep(state.snapshot, snapshot);
    return state.status === 'ready' && next === state.snapshot ? state : { status: 'ready', snapshot: next };
  };
  const keyFor = (input: MachineScheduledKey) => JSON.stringify([input.serverId, input.accountId, input.credentialKey, input.machineId, input.offset ?? 0, input.pageSize]);
  const rescanRequested = new Set<string>();
  const store = createSharedSubscriptionStore<MachineScheduledKey, MachineScheduledState, Snapshot, MachineScheduledClient, MachineScheduledClient>({
    emptyState: EMPTY, createState: () => EMPTY, normalizeInput: input => input,
    storeKey: keyFor,
    defaultSnapshotClient: request, defaultWatchClient: request, watchAfterRefresh: true, retainState: true,
    subscribeRetirement: subscribeLocalServiceCredentialRetirement,
    subscribeRecovery: (input, recover) => subscribeMachineRpcRecovery({ ...input, expectedAccountId: input.accountId }, recover),
    shouldWatch: state => state.status === 'ready',
    refresh: async ({ input, state, snapshotClient, signal }) => {
      const result = await snapshotClient('machines.scheduled.list', { ...input, ...(rescanRequested.delete(keyFor(input)) ? { refresh: true } : {}) }, signal);
      return result.kind === 'snapshot' ? (current: MachineScheduledState) => apply(current, result) : state;
    },
    failRefresh: (state, _input, _now, error) => failure(state, error),
    failWatch: state => failure(state, { code: 'observation_unavailable' }),
    applySnapshot: apply,
    watch: async ({ input, state, watchClient, signal }) => {
      const result = await watchClient('machines.scheduled.watch', { ...input, ...(state.snapshot ? { sinceRevision: state.snapshot.revision } : {}) }, signal);
      return result.kind === 'snapshot' ? { status: 'changed', snapshot: result } : { status: 'idle' };
    },
  });
  return { ...store, refresh(input: MachineScheduledKey) { rescanRequested.add(keyFor(input)); store.invalidate(input); return store.read(input); } };
}
export const machineScheduledStore = createMachineScheduledStore();

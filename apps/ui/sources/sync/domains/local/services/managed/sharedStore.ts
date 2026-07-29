import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
import {
    type LocalServiceManagedSnapshotClientInput,
    type LocalServiceManagedSnapshotClientResult,
} from './api';
import { fetchLocalServiceManagedSnapshotViaMachineRpc } from './machineRpc';
import {
    applyManagedLocalServicesRefreshStarted,
    applyManagedLocalServicesSnapshot,
    createManagedLocalServicesState,
    failManagedLocalServicesRefresh,
    type ManagedLocalServicesSnapshot,
    type ManagedLocalServicesState,
} from './store';

export type LocalServiceManagedSnapshotClient = (
    input: LocalServiceManagedSnapshotClientInput,
) => Promise<LocalServiceManagedSnapshotClientResult>;

export type ManagedLocalServicesStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
}>;

type NormalizedManagedLocalServicesStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
}>;

export const EMPTY_MANAGED_LOCAL_SERVICES_STATE: ManagedLocalServicesState = createManagedLocalServicesState();

const defaultSnapshotClient: LocalServiceManagedSnapshotClient = (input) => (
    fetchLocalServiceManagedSnapshotViaMachineRpc(input)
);

function normalizeInput(input: ManagedLocalServicesStoreKeyInput): NormalizedManagedLocalServicesStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: input.sessionId ?? null,
    };
}

function storeKey(input: ManagedLocalServicesStoreKeyInput): string {
    return `${input.serverId ?? ''}::${input.machineId}::${input.sessionId ?? ''}`;
}

function failRefresh(
    state: ManagedLocalServicesState,
    generatedAt: number,
    reasonCode: string,
): ManagedLocalServicesState {
    return failManagedLocalServicesRefresh(state, { generatedAt, reasonCode });
}

const store = createLocalServicesSharedSubscriptionStore<
    ManagedLocalServicesStoreKeyInput,
    ManagedLocalServicesState,
    ManagedLocalServicesSnapshot,
    LocalServiceManagedSnapshotClient
>({
    emptyState: EMPTY_MANAGED_LOCAL_SERVICES_STATE,
    createState: createManagedLocalServicesState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state, _input, nowMs) => applyManagedLocalServicesRefreshStarted(state, nowMs()),
    refresh: async ({ input, state, snapshotClient, nowMs, signal }) => {
        const result = await snapshotClient({
            machineId: input.machineId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            signal,
        });
        return result.ok
            ? applyManagedLocalServicesSnapshot(state, result.snapshot)
            : failRefresh(state, nowMs(), `managed_local_services_${result.reason}`);
    },
    failRefresh: (state, _input, nowMs) => (
        failRefresh(state, nowMs(), 'managed_local_services_request_failed')
    ),
    applySnapshot: applyManagedLocalServicesSnapshot,
});

export function getManagedLocalServicesState(
    input: ManagedLocalServicesStoreKeyInput,
): ManagedLocalServicesState {
    return store.getState(input);
}

export function subscribeManagedLocalServicesStore(
    input: ManagedLocalServicesStoreKeyInput,
    listener: () => void,
    options?: Readonly<{ snapshotClient?: LocalServiceManagedSnapshotClient; nowMs?: () => number }>,
): () => void {
    return store.subscribe(input, listener, options);
}

export function invalidateManagedLocalServicesStore(input: ManagedLocalServicesStoreKeyInput): void {
    store.invalidate(input);
}

export function publishManagedLocalServicesSnapshot(
    input: ManagedLocalServicesStoreKeyInput,
    snapshot: ManagedLocalServicesSnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetManagedLocalServicesStoreForTests(): void {
    store.reset();
}

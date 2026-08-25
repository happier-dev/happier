import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
    type LocalServiceInventoryWatchClientInput,
    type LocalServiceInventoryWatchClientResult,
} from './api';
import {
    fetchLocalServiceInventorySnapshotViaMachineRpc,
    watchLocalServiceInventorySnapshotViaMachineRpc,
} from './machineRpc';
import {
    applyLocalServiceInventoryRefreshFailed,
    applyLocalServiceInventoryRefreshStarted,
    applyLocalServiceInventorySnapshot,
    createLocalServiceInventoryState,
    type LocalServiceInventorySnapshot,
    type LocalServiceInventoryState,
} from './store';

export type LocalServiceInventorySnapshotClient = (
    input: LocalServiceInventorySnapshotClientInput,
) => Promise<LocalServiceInventorySnapshotClientResult>;

export type LocalServiceInventoryWatchClient = (
    input: LocalServiceInventoryWatchClientInput,
) => Promise<LocalServiceInventoryWatchClientResult>;

export type LocalServiceInventoryStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
}>;

type NormalizedLocalServiceInventoryStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
}>;

export const EMPTY_LOCAL_SERVICE_INVENTORY_STATE: LocalServiceInventoryState = createLocalServiceInventoryState();

const defaultSnapshotClient: LocalServiceInventorySnapshotClient = (input) => (
    fetchLocalServiceInventorySnapshotViaMachineRpc(input)
);

const defaultWatchClient: LocalServiceInventoryWatchClient = (input) => (
    watchLocalServiceInventorySnapshotViaMachineRpc(input)
);

function normalizeInput(input: LocalServiceInventoryStoreKeyInput): NormalizedLocalServiceInventoryStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: input.sessionId ?? null,
    };
}

function storeKey(input: LocalServiceInventoryStoreKeyInput): string {
    return `${input.serverId ?? ''}::${input.machineId}::${input.sessionId ?? ''}`;
}

const store = createLocalServicesSharedSubscriptionStore<
    LocalServiceInventoryStoreKeyInput,
    LocalServiceInventoryState,
    LocalServiceInventorySnapshot,
    LocalServiceInventorySnapshotClient,
    LocalServiceInventoryWatchClient
>({
    emptyState: EMPTY_LOCAL_SERVICE_INVENTORY_STATE,
    createState: createLocalServiceInventoryState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state, input) => (
        applyLocalServiceInventoryRefreshStarted(state, input.machineId)
    ),
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const result = await snapshotClient({
            machineId: input.machineId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            refresh: true,
            signal,
        });
        return result.ok
            ? applyLocalServiceInventorySnapshot(state, result.snapshot)
            : applyLocalServiceInventoryRefreshFailed(state, input.machineId);
    },
    failRefresh: (state, input) => (
        applyLocalServiceInventoryRefreshFailed(state, input.machineId)
    ),
    applySnapshot: applyLocalServiceInventorySnapshot,
    defaultWatchClient,
    // Freshness comes from the daemon: one parked watch per subscribed machine, re-armed on each
    // answer. `sinceGeneratedAt` closes the window between this store's snapshot read and its
    // first watch so a service that starts in between is not missed.
    watch: async ({ input, state, watchClient, signal }) => {
        const result = await watchClient({
            machineId: input.machineId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            sinceGeneratedAt: state.generatedAt,
            ...(signal ? { signal } : {}),
        });
        if (!result.ok) {
            return { status: 'unavailable' };
        }
        return result.changed
            ? { status: 'changed', snapshot: result.snapshot }
            : { status: 'idle' };
    },
});

export function getLocalServiceInventoryState(
    input: LocalServiceInventoryStoreKeyInput,
): LocalServiceInventoryState {
    return store.getState(input);
}

export function subscribeLocalServiceInventoryStore(
    input: LocalServiceInventoryStoreKeyInput,
    listener: () => void,
    options?: Readonly<{
        snapshotClient?: LocalServiceInventorySnapshotClient;
        watchClient?: LocalServiceInventoryWatchClient;
        nowMs?: () => number;
    }>,
): () => void {
    return store.subscribe(input, listener, options);
}

export function invalidateLocalServiceInventoryStore(input: LocalServiceInventoryStoreKeyInput): void {
    store.invalidate(input);
}

export function publishLocalServiceInventorySnapshot(
    input: LocalServiceInventoryStoreKeyInput,
    snapshot: LocalServiceInventorySnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServiceInventoryStoreForTests(): void {
    store.reset();
}

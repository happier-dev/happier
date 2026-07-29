import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
} from './api';
import { fetchLocalServiceInventorySnapshotViaMachineRpc } from './machineRpc';
import {
    applyLocalServiceInventoryRefreshStarted,
    applyLocalServiceInventorySnapshot,
    createLocalServiceInventoryState,
    selectLocalServiceInventoryRows,
    type LocalServiceInventorySnapshot,
    type LocalServiceInventoryState,
} from './store';

export type LocalServiceInventorySnapshotClient = (
    input: LocalServiceInventorySnapshotClientInput,
) => Promise<LocalServiceInventorySnapshotClientResult>;

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

function failClosedSnapshot(
    previous: LocalServiceInventoryState,
    machineId: string,
    generatedAt: number,
): LocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId,
        generatedAt,
        refreshState: 'error',
        entries: selectLocalServiceInventoryRows(previous),
        diagnostics: [],
    };
}

const store = createLocalServicesSharedSubscriptionStore<
    LocalServiceInventoryStoreKeyInput,
    LocalServiceInventoryState,
    LocalServiceInventorySnapshot,
    LocalServiceInventorySnapshotClient
>({
    emptyState: EMPTY_LOCAL_SERVICE_INVENTORY_STATE,
    createState: createLocalServiceInventoryState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state, input, nowMs) => (
        applyLocalServiceInventoryRefreshStarted(state, input.machineId, nowMs())
    ),
    refresh: async ({ input, state, snapshotClient, nowMs, signal }) => {
        const result = await snapshotClient({
            machineId: input.machineId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            refresh: true,
            signal,
        });
        return applyLocalServiceInventorySnapshot(
            state,
            result.ok ? result.snapshot : failClosedSnapshot(state, input.machineId, nowMs()),
        );
    },
    failRefresh: (state, input, nowMs) => (
        applyLocalServiceInventorySnapshot(state, failClosedSnapshot(state, input.machineId, nowMs()))
    ),
    applySnapshot: applyLocalServiceInventorySnapshot,
});

export function getLocalServiceInventoryState(
    input: LocalServiceInventoryStoreKeyInput,
): LocalServiceInventoryState {
    return store.getState(input);
}

export function subscribeLocalServiceInventoryStore(
    input: LocalServiceInventoryStoreKeyInput,
    listener: () => void,
    options?: Readonly<{ snapshotClient?: LocalServiceInventorySnapshotClient; nowMs?: () => number }>,
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

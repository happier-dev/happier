import { createLocalServicesSharedSubscriptionStore } from '../sharedSubscriptionStore';
import {
    type LocalServicePreviewSnapshotClientInput,
    type LocalServicePreviewSnapshotClientResult,
} from './api';
import { fetchLocalServicePreviewSnapshotViaMachineRpc } from './machineRpc';
import {
    applyLocalServicePreviewRefreshFailed,
    applyLocalServicePreviewRefreshStarted,
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
    type LocalServicePreviewSnapshot,
    type LocalServicePreviewState,
} from './store';

// PRV-4 (PPT-3/DUP-6): one shared preview-status store.
//
// Previously every consumer of `useLocalServicePreviewState` owned a private `useState` plus a
// per-mount 15s `setInterval` poll, while the `localServices.preview.*` runtime actions read the
// same daemon route into a detached action result — two divergent truths and N wall-clock timers.
//
// This module is the single backing model (mirroring VS Code's Ports view): keyed by
// (serverId, machineId), it does exactly one fetch when a key gains its first subscriber and is
// otherwise refreshed by invalidation — the runtime-action executor publishes each
// openOrCreate / revoke / status snapshot straight into the store, so an open pane updates
// immediately without polling. No `setInterval` anywhere.
//
// The keyed subscription/refcount/in-flight machinery is owned by the shared
// `createLocalServicesSharedSubscriptionStore` factory (the same owner backing the inventory,
// managed, and launcher stores) — this module is only the preview-domain adapter.

export type LocalServicePreviewSnapshotClient = (
    input: LocalServicePreviewSnapshotClientInput,
) => Promise<LocalServicePreviewSnapshotClientResult>;

export type LocalServicePreviewStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
}>;

type NormalizedLocalServicePreviewStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
}>;

// Stable empty reference so `getState` for an absent/disabled key never churns the
// `useSyncExternalStore` snapshot identity.
export const EMPTY_LOCAL_SERVICE_PREVIEW_STATE: LocalServicePreviewState = createLocalServicePreviewState();

const defaultSnapshotClient: LocalServicePreviewSnapshotClient = (input) => (
    fetchLocalServicePreviewSnapshotViaMachineRpc(input)
);

function normalizeInput(input: LocalServicePreviewStoreKeyInput): NormalizedLocalServicePreviewStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
    };
}

function storeKey(input: LocalServicePreviewStoreKeyInput): string {
    return `${input.serverId ?? ''}::${input.machineId}`;
}

const store = createLocalServicesSharedSubscriptionStore<
    LocalServicePreviewStoreKeyInput,
    LocalServicePreviewState,
    LocalServicePreviewSnapshot,
    LocalServicePreviewSnapshotClient
>({
    emptyState: EMPTY_LOCAL_SERVICE_PREVIEW_STATE,
    createState: createLocalServicePreviewState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state) => applyLocalServicePreviewRefreshStarted(state),
    refresh: async ({ input, state, snapshotClient, nowMs, signal }) => {
        const result = await snapshotClient({
            machineId: input.machineId,
            serverId: input.serverId ?? null,
            signal,
        });
        return result.ok
            ? applyLocalServicePreviewSnapshot(state, result.snapshot)
            : applyLocalServicePreviewRefreshFailed(state);
    },
    failRefresh: (state) => applyLocalServicePreviewRefreshFailed(state),
    applySnapshot: applyLocalServicePreviewSnapshot,
});

export function getLocalServicePreviewState(
    input: LocalServicePreviewStoreKeyInput,
): LocalServicePreviewState {
    return store.getState(input);
}

export type SubscribeLocalServicePreviewStoreOptions = Readonly<{
    snapshotClient?: LocalServicePreviewSnapshotClient;
    nowMs?: () => number;
}>;

export function subscribeLocalServicePreviewStore(
    input: LocalServicePreviewStoreKeyInput,
    listener: () => void,
    options?: SubscribeLocalServicePreviewStoreOptions,
): () => void {
    return store.subscribe(input, listener, options);
}

// Subscription-driven invalidation: re-fetch the snapshot for an active key. Intended for an
// external observability signal (PMS-9) once a UI-facing push channel exists; safe no-op when the
// key has no live subscriber (nothing to refresh into).
export function invalidateLocalServicePreviewStore(
    input: LocalServicePreviewStoreKeyInput,
): void {
    store.invalidate(input);
}

// Action-driven invalidation: the runtime-action executor publishes the authoritative snapshot a
// `preview.openOrCreate` / `revoke` / `status` dispatch returned so any open pane refreshes
// immediately from the same store the poll-less subscribers read.
export function publishLocalServicePreviewSnapshot(
    input: LocalServicePreviewStoreKeyInput,
    snapshot: LocalServicePreviewSnapshot,
): void {
    store.publish(input, snapshot);
}

// Test-only: drop all keyed entries so a singleton store does not leak across cases.
export function resetLocalServicePreviewStoreForTests(): void {
    store.reset();
}

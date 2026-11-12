import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import {
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
    type LocalServiceLauncherWatchClientInput,
    type LocalServiceLauncherWatchClientResult,
} from './api';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc, watchLocalServiceLauncherSnapshotViaMachineRpc } from './machineRpc';
import {
    applyLocalServiceLauncherRefreshStarted,
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    failLocalServiceLauncherRefresh,
    readLocalServiceLauncherSnapshotTime,
    selectLocalServiceLaunchTargets,
} from './store';
import type { LocalServiceLauncherSnapshot, LocalServiceLauncherState } from './types';
import { subscribeLocalServiceCredentialRetirement } from '../inventory/sharedStore';
import { invalidateLocalServicePreviewStore } from '../preview/sharedStore';

export type LocalServiceLauncherSnapshotClient = (
    input: LocalServiceLauncherSnapshotClientInput,
) => Promise<LocalServiceLauncherSnapshotClientResult>;
type LocalServiceLauncherWatchClient = (input: LocalServiceLauncherWatchClientInput) => Promise<LocalServiceLauncherWatchClientResult>;

export type LocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine' | null;
    workspaceRoot?: string | null;
    projection?: 'managed_bindings' | null;
    accountId?: string | null;
    credentialKey?: string | null;
}>;

type NormalizedLocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
    scope: 'workspace' | 'machine' | null;
    workspaceRoot: string | null;
    projection: 'managed_bindings' | null;
    accountId: string | null;
    credentialKey: string | null;
}>;

export const EMPTY_LOCAL_SERVICE_LAUNCHER_STATE: LocalServiceLauncherState = createLocalServiceLauncherState();

const defaultSnapshotClient: LocalServiceLauncherSnapshotClient = (input) => (
    fetchLocalServiceLauncherSnapshotViaMachineRpc(input)
);
const defaultWatchClient: LocalServiceLauncherWatchClient = (input) => (
    watchLocalServiceLauncherSnapshotViaMachineRpc(input)
);

function normalizeInput(input: LocalServiceLauncherStoreKeyInput): NormalizedLocalServiceLauncherStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: input.sessionId ?? null,
        scope: input.scope ?? null,
        workspaceRoot: input.workspaceRoot ?? null,
        projection: input.projection ?? null,
        accountId: input.accountId ?? null,
        credentialKey: input.credentialKey ?? null,
    };
}

function storeKey(input: LocalServiceLauncherStoreKeyInput): string {
    return JSON.stringify([
        input.serverId ?? '',
        input.machineId,
        input.sessionId ?? '',
        input.scope ?? '',
        input.workspaceRoot ?? '',
        input.projection ?? '',
        input.accountId ?? '',
        input.credentialKey ?? '',
    ]);
}

function entryMatches(
    entryInput: LocalServiceLauncherStoreKeyInput,
    publishInput: LocalServiceLauncherStoreKeyInput,
): boolean {
    const entry = normalizeInput(entryInput);
    return entry.machineId === publishInput.machineId
        && entry.accountId === (publishInput.accountId ?? null)
        && entry.credentialKey === (publishInput.credentialKey ?? null)
        && (publishInput.serverId === undefined || entry.serverId === (publishInput.serverId ?? null))
        && (publishInput.sessionId === undefined || entry.sessionId === (publishInput.sessionId ?? null))
        && (publishInput.scope === undefined || entry.scope === (publishInput.scope ?? null))
        && (publishInput.workspaceRoot === undefined || entry.workspaceRoot === (publishInput.workspaceRoot ?? null));
}

function failRefresh(
    state: LocalServiceLauncherState,
    input: NormalizedLocalServiceLauncherStoreKeyInput,
    reasonCode: string,
): LocalServiceLauncherState {
    return failLocalServiceLauncherRefresh(state, {
        machineId: input.machineId,
        sessionId: input.sessionId ?? undefined,
        reasonCode,
    });
}

const store = createSharedSubscriptionStore<
    LocalServiceLauncherStoreKeyInput,
    LocalServiceLauncherState,
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherWatchClient
>({
    // Same credential-owned retention and qualified identity as the inventory freshness owner.
    retainState: true,
    subscribeRetirement: (input, retire) => subscribeLocalServiceCredentialRetirement(input, () => {
        const key = storeKey(normalizeInput(input));
        launcherSubscriptions.delete(key);
        retire();
    }),
    emptyState: EMPTY_LOCAL_SERVICE_LAUNCHER_STATE,
    createState: createLocalServiceLauncherState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    // A launcher read can fail while inventory remains healthy and unchanged. Its own
    // demand must recover on the same authenticated reconnect, without a scan delta.
    subscribeRecovery: (input, recover) => subscribeMachineRpcRecovery({ ...input, expectedAccountId: input.accountId }, () => recover(true)),
    beginRefresh: (state, input) => {
        if (state.updatedAt !== null) return state;
        const normalized = normalizeInput(input);
        return applyLocalServiceLauncherRefreshStarted(state, {
            machineId: normalized.machineId,
            sessionId: normalized.sessionId ?? undefined,
        });
    },
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const normalized = normalizeInput(input);
        // Inventory owns listener observations; the launcher independently owns declarations
        // and supervised lifetimes, including when a listener scan failed.
        const receivedAt = readLocalServiceLauncherSnapshotTime(state);
        const result = await snapshotClient({
            machineId: normalized.machineId,
            serverId: normalized.serverId,
            sessionId: normalized.sessionId,
            scope: normalized.scope,
            workspaceRoot: normalized.workspaceRoot,
            ...(normalized.projection ? { projection: normalized.projection } : {}),
            ...(normalized.accountId ? { accountId: normalized.accountId } : {}),
            signal,
        });
        // An Action can publish during the read or after this callback returns.
        // Reconcile once, atomically at the shared owner's commit boundary.
        return (current: LocalServiceLauncherState) => {
            if (!result.ok) return readLocalServiceLauncherSnapshotTime(current) !== receivedAt
                ? current : failRefresh(current, normalized, result.reason);
            const previousTime = readLocalServiceLauncherSnapshotTime(current);
            const next = applyLocalServiceLauncherSnapshot(current, result.snapshot);
            // Browser demand may outlive the launcher's scoped watch. Its first
            // fresh read closes that gap before parking at the new cursor.
            if (readLocalServiceLauncherSnapshotTime(next) !== previousTime) invalidateLocalServicePreviewStore(input);
            return next;
        };
    },
    failRefresh: (state, input) => (
        failRefresh(state, normalizeInput(input), 'request_failed')
    ),
    applySnapshot: applyLocalServiceLauncherSnapshot,
    defaultWatchClient,
    watchAfterRefresh: true,
    shouldWatch: state => state.updatedAt !== null,
    // Browser demand now holds this scoped watch rather than broad inventory.
    // Preview membership must follow the same daemon change without a manual Reload.
    onWatchSnapshot: input => invalidateLocalServicePreviewStore(input),
    watch: async ({ input, state, watchClient, signal }) => {
        const result = await watchClient({ ...normalizeInput(input),
            projection: input.projection ?? undefined, targets: [...selectLocalServiceLaunchTargets(state)], signal });
        if (!result.ok) return { status: 'unavailable' };
        return result.changed ? { status: 'changed', snapshot: result.snapshot } : { status: 'idle' };
    },
    // A scoped mutation can change every demanded projection on this Machine.
    // Scope decides whether its snapshot covers a consumer, not whether that
    // consumer learns about the mutation at all.
    matchesPublish: (entry, { machineId, serverId, accountId, credentialKey }) => (
        entryMatches(entry, { machineId, serverId, accountId, credentialKey })
    ),
    // An Action's response only covers the scope it read. Other affected consumers
    // refresh their own projection rather than adopting a machine-wide/other-Session feed.
    snapshotCoversEntry: (entry, _snapshot, published) => storeKey(entry) === storeKey(normalizeInput(published)),
});

// Track mounted scopes for explicit external mutation/recovery publications.
// Each scope's existing shared store owns its projected parked watch.
const launcherSubscriptions = new Map<string, { input: LocalServiceLauncherStoreKeyInput; count: number }>();

export function getLocalServiceLauncherState(
    input: LocalServiceLauncherStoreKeyInput,
): LocalServiceLauncherState {
    return store.getState(input);
}

/** Join the subscribed owner's first/current read before consuming its projection. */
export function readLocalServiceLauncherStore(input: LocalServiceLauncherStoreKeyInput): Promise<void> {
    return store.readOnce(input);
}

export function subscribeLocalServiceLauncherStore(
    input: LocalServiceLauncherStoreKeyInput,
    listener: () => void,
    options?: Readonly<{ snapshotClient?: LocalServiceLauncherSnapshotClient; nowMs?: () => number }>,
): () => void {
    const key = storeKey(normalizeInput(input));
    let subscription = launcherSubscriptions.get(key);
    if (!subscription) {
        subscription = { input, count: 0 };
        launcherSubscriptions.set(key, subscription);
    }
    subscription.count++;
    const unsubscribe = store.subscribe(input, listener, options);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        if (--subscription.count === 0) {
            if (launcherSubscriptions.get(key) === subscription) launcherSubscriptions.delete(key);
        }
    };
}

export function invalidateLocalServiceLauncherStore(input: LocalServiceLauncherStoreKeyInput): void {
    store.invalidate(input);
}

/** External native operations change every subscribed scope/projection on the affected Machine. */
export function invalidateLocalServiceLauncherStores(input: Pick<LocalServiceLauncherStoreKeyInput, 'machineId' | 'serverId' | 'accountId' | 'credentialKey'>): void {
    const scope = { ...input, serverId: input.serverId ?? null };
    for (const subscription of launcherSubscriptions.values()) {
        if (entryMatches(subscription.input, scope)) store.invalidate(subscription.input);
    }
}

/** A successful explicit scan may return the same generation. Recover failed derived
 * reads without making healthy projections re-read unchanged inventory. */
export function recoverLocalServiceLauncherStores(input: Pick<LocalServiceLauncherStoreKeyInput, 'machineId' | 'serverId' | 'accountId' | 'credentialKey'>): void {
    const scope = { ...input, serverId: input.serverId ?? null };
    for (const subscription of launcherSubscriptions.values()) {
        if (entryMatches(subscription.input, scope) && store.getState(subscription.input).refreshStatus === 'error') {
            store.invalidate(subscription.input);
        }
    }
}

export function publishLocalServiceLauncherSnapshot(
    input: LocalServiceLauncherStoreKeyInput,
    snapshot: LocalServiceLauncherSnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServiceLauncherStoreForTests(): void {
    launcherSubscriptions.clear();
    store.reset();
}

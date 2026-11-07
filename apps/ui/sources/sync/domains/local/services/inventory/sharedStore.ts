import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { LocalServiceMachineSummaryV1Schema, type LocalServiceMachineSummaryV1 } from '@happier-dev/protocol/local/services/inventory/v1';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { invalidateLocalServicePreviewStore } from '../preview/sharedStore';
import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
    type LocalServiceInventoryWatchClientInput,
    type LocalServiceInventoryWatchClientResult,
} from './api';
import {
    fetchLocalServiceInventorySnapshotViaMachineRpc,
    watchLocalServiceInventorySnapshotViaMachineRpc,
    fetchLocalServiceInventorySummaryViaMachineRpc,
} from './machineRpc';
import {
    applyLocalServiceInventoryRefreshFailed,
    applyLocalServiceInventoryRefreshStarted,
    applyLocalServiceInventorySnapshot,
    applyLocalServiceInventorySummary,
    applyLocalServiceInventoryMachineSummary,
    readLocalServiceInventoryMachineSummarySource,
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
    accountId?: string | null;
    credentialKey?: string | null;
    launcherScopes?: LocalServiceInventoryWatchClientInput['launcherScopes'];
}>;

type NormalizedLocalServiceInventoryStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
    accountId: string | null;
    credentialKey: string | null;
    launcherScopes?: LocalServiceInventoryWatchClientInput['launcherScopes'];
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
        // Inventory RPCs are Machine-wide; Session surfaces share the same scan and watch.
        sessionId: null,
        accountId: input.accountId ?? null,
        credentialKey: input.credentialKey ?? null,
        launcherScopes: input.launcherScopes,
    };
}

function storeKey(input: LocalServiceInventoryStoreKeyInput): string {
    return JSON.stringify([input.serverId ?? '', input.machineId, input.accountId ?? '', input.credentialKey ?? '']);
}

/** Credential mutation outlives a surface's hook lifetime and ordinary close/unmount. */
export function subscribeLocalServiceCredentialRetirement(
    input: Pick<LocalServiceInventoryStoreKeyInput, 'serverId' | 'accountId' | 'credentialKey'>,
    retire: () => void,
): () => void {
    if (!input.serverId || !input.accountId || !input.credentialKey) return () => {};
    const { serverId, credentialKey } = input;
    return subscribeHomeCredentialChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
        if (event.kind === 'credentials_set' && event.credentials
            && resolveAuthCredentialsScopeKey(event.credentials) === credentialKey) return;
        retire();
    });
}

// The daemon keeps its inventory within its own scan interval, so returning demand
// (a widget shown again, a foreground return, a recovered transport) reads it. Only
// an explicit refresh asks the daemon to scan now.
const rescanRequested = new Set<string>();

const store = createSharedSubscriptionStore<
    LocalServiceInventoryStoreKeyInput,
    LocalServiceInventoryState,
    LocalServiceInventorySnapshot | Readonly<{ summary: LocalServiceMachineSummaryV1; machineSummarySource?: object | null }>,
    LocalServiceInventorySnapshotClient,
    LocalServiceInventoryWatchClient
>({
    // Close retains display facts; actual credential replacement/removal drops them.
    retainState: true,
    subscribeRetirement: subscribeLocalServiceCredentialRetirement,
    emptyState: EMPTY_LOCAL_SERVICE_INVENTORY_STATE,
    createState: createLocalServiceInventoryState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    beginRefresh: (state, input) => (
        applyLocalServiceInventoryRefreshStarted(state, input.machineId)
    ),
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const receivedAt = state.generatedAt;
        const receivedSummary = state.summary;
        const receivedSource = readLocalServiceInventoryMachineSummarySource(state);
        const result = await snapshotClient({
            machineId: input.machineId,
            serverId: input.serverId,
            accountId: input.accountId,
            sessionId: input.sessionId,
            refresh: rescanRequested.delete(storeKey(input)),
            signal,
        });
        return (current: LocalServiceInventoryState) => {
            if (!result.ok) {
                if (current.generatedAt !== receivedAt) return current;
                // A current census may arrive before this older read fails. Preserve
                // its recovery wake just as publishSummary does after an error.
                if (current.summary?.state === 'ready' && (current.summary !== receivedSummary
                    || readLocalServiceInventoryMachineSummarySource(current) !== receivedSource)) {
                    store.invalidate(input);
                    return current;
                }
                return applyLocalServiceInventoryRefreshFailed(current, input.machineId);
            }
            const next = applyLocalServiceInventorySnapshot(current, result.snapshot);
            // A retained Browser may outlive hidden inventory demand. Its next
            // read closes that observation gap before the new watch cursor parks.
            if (next.generatedAt !== current.generatedAt) invalidateLocalServicePreviewStore(input);
            return next;
        };
    },
    failRefresh: (state, input) => (
        applyLocalServiceInventoryRefreshFailed(state, input.machineId)
    ),
    failWatch: (state, input) => applyLocalServiceInventoryRefreshFailed(state, input.machineId),
    subscribeRecovery: (input, recover) => subscribeMachineRpcRecovery({ ...input, expectedAccountId: input.accountId }, recover),
    applySnapshot: (state, snapshot) => {
        if (!('summary' in snapshot)) return applyLocalServiceInventorySnapshot(state, snapshot);
        return 'machineSummarySource' in snapshot
            ? applyLocalServiceInventoryMachineSummary(state, snapshot.summary, snapshot.machineSummarySource ?? null)
            : applyLocalServiceInventorySummary(state, snapshot.summary);
    },
    defaultWatchClient,
    watchAfterRefresh: true,
    // One cancellation-owned observation spans every snapshot answer/re-arm gap.
    observeWatch: async ({ input, watchClient, signal }) => {
        await watchClient({
            machineId: input.machineId,
            serverId: input.serverId,
            accountId: input.accountId,
            observationOnly: true,
            launcherScopes: input.launcherScopes,
            signal,
        });
    },
    // Preview membership shares this Machine watch. Its canonical snapshot must
    // be re-read even if a launcher projection never observed the registration.
    // One notification per shared watch, not one per Session/launcher consumer.
    onWatchSnapshot: (input) => invalidateLocalServicePreviewStore(input),
    // Freshness comes from the daemon: one snapshot watch per subscribed Machine, re-armed on each
    // answer alongside its shared observation lifetime. `sinceGeneratedAt` closes the window
    // between the snapshot read and first watch so a service that starts in between is not missed.
    watch: async ({ input, state, watchClient, signal }) => {
        const result = await watchClient({
            machineId: input.machineId,
            serverId: input.serverId,
            accountId: input.accountId,
            sessionId: input.sessionId,
            sinceGeneratedAt: state.generatedAt,
            ...(signal ? { signal } : {}),
        });
        if (!result.ok) {
            // A watch can spend its existing RPC budget waiting for a cold scan before
            // parking. Keep observation alive after that deadline, with the same cursor;
            // immediate refusals and invalid responses still retire instead of spinning.
            if (result.reasonCode === MACHINE_RPC_TIMEOUT_ERROR_CODE) return { status: 'retry' };
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

export function getLocalServiceInventoryRunningCount(input: LocalServiceInventoryStoreKeyInput): number | null {
    const summary = store.getState(input).summary;
    return summary?.state === 'ready' ? summary.runningCount : null;
}

/** Passive observation does not acquire the inventory's refresh or parked watch. */
export function observeLocalServiceInventorySummary(input: LocalServiceInventoryStoreKeyInput, listener: () => void): () => void {
    return store.observe(input, listener);
}

export function publishLocalServiceInventorySummary(input: LocalServiceInventoryStoreKeyInput, summary: LocalServiceMachineSummaryV1): void {
    publishSummary(input, { summary });
}

function publishSummary(input: LocalServiceInventoryStoreKeyInput,
    snapshot: Readonly<{ summary: LocalServiceMachineSummaryV1; machineSummarySource?: object | null }>): void {
    // A new ready observation can arrive without a transport reconnect (for example
    // after a Service restarts). Revalidate failed detail demand, not passive scalar
    // consumers, so the fresh inventory restores its watch and derived launcher rows.
    const recover = snapshot.summary.state === 'ready' && store.getState(input).refreshState === 'error';
    const release = store.observe(input, () => {});
    store.publish(input, snapshot, { resumeWatch: false });
    if (recover) store.invalidate(input);
    release();
}

/** Untyped Machine daemon-state content enters the inventory summary owner once per receipt. */
export function publishLocalServiceInventoryMachineSummary(input: LocalServiceInventoryStoreKeyInput, received: unknown): void {
    if (typeof received === 'object' && received !== null && received === readLocalServiceInventoryMachineSummarySource(store.getState(input))) return;
    const parsed = LocalServiceMachineSummaryV1Schema.safeParse(received);
    const source = parsed.success && typeof received === 'object' && received !== null ? received : null;
    publishSummary(input, { summary: parsed.success ? parsed.data : { v: 1, state: 'unknown' }, machineSummarySource: source });
}

/** Owned by the mounted Session address; repeated calls share its single allowance. */
export function createLocalServiceInventoryCountAcquisition(input: LocalServiceInventoryStoreKeyInput): Readonly<{
    readOnce(): Promise<void>;
    dispose(): void;
}> {
    return store.acquireReadOnce(input, input.sessionId ?? '', async signal => {
        if (getLocalServiceInventoryRunningCount(input) !== null) return;
        const previous = store.getState(input);
        const previousSource = readLocalServiceInventoryMachineSummarySource(previous);
        const summary = await fetchLocalServiceInventorySummaryViaMachineRpc({ ...input, signal });
        const current = store.getState(input);
        if (!signal.aborted && summary && current.summary === previous.summary
            && readLocalServiceInventoryMachineSummarySource(current) === previousSource && current.generatedAt === previous.generatedAt) {
            publishLocalServiceInventorySummary(input, summary);
        }
    });
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

/** Renew only the mounted launcher demand; the Machine snapshot and value cursor still apply. */
export function reconfigureLocalServiceInventoryLauncherScopes(input: LocalServiceInventoryStoreKeyInput): void {
    store.reconfigure(input, { refresh: false });
}

/** An explicit refresh: the daemon rescans now. */
export function invalidateLocalServiceInventoryStore(input: LocalServiceInventoryStoreKeyInput): void {
    rescanRequested.add(storeKey(normalizeInput(input)));
    store.invalidate(input);
}

/** Re-read the daemon's current inventory and restart the watch, without forcing a scan. */
export function revalidateLocalServiceInventoryStore(input: LocalServiceInventoryStoreKeyInput): void {
    store.invalidate(input);
}

export function publishLocalServiceInventorySnapshot(
    input: LocalServiceInventoryStoreKeyInput,
    snapshot: LocalServiceInventorySnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServiceInventoryStoreForTests(): void {
    rescanRequested.clear();
    store.reset();
}

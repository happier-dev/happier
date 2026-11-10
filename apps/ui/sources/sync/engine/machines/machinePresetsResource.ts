import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { createMachinePresetCollectionClient } from '@/sync/ops/machines/machinePresetCollectionClient';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export type MachinePresetQueryState<T> = Readonly<{
    value: T | null;
    loading: boolean;
    error: string | null;
    approval?: ActionApprovalRegistration;
}>;
type Snapshot = MachinePresetQueryState<readonly ManagedMachinePresetV1[]>;
type Consumer = Readonly<{ onApprovalPending?: (approval: ActionApprovalRegistration) => void }>;
type PendingRead = { controller: AbortController; awaitingApproval: boolean };
type Entry = {
    lifetime: ServerAccountScopeLifetime;
    homeId: string;
    snapshot: Snapshot;
    consumers: Set<Consumer>;
    retirement: { dispose(): void };
    read: PendingRead | null;
    stale: boolean;
};

const empty: Snapshot = { value: null, loading: true, error: null };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const scopeId = (serverId: string) => resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
let stopObserving: (() => void) | undefined;
let stopDemanding: (() => void) | undefined;
let demandedHomes = '';

export function isMachinePresetAccessLost(code: string): boolean {
    return code === 'permission_denied' || code === 'preset_not_found' || code === 'action_account_scope_changed';
}

function notify(serverId: string) {
    for (const listener of listeners.get(serverId) ?? []) listener();
}

function publish(serverId: string, entry: Entry, next: Snapshot) {
    const retained = retainShallow(entry.snapshot, next);
    if (retained === entry.snapshot) return;
    entry.snapshot = retained;
    notify(serverId);
}

function load(serverId: string, entry: Entry) {
    if (entry.read || !entry.stale || !entry.lifetime.isCurrent() || entry.consumers.size === 0) return;
    const read: PendingRead = { controller: new AbortController(), awaitingApproval: false };
    entry.read = read;
    entry.stale = false;
    if (entry.snapshot.approval) {
        const { approval: _approval, ...settled } = entry.snapshot;
        publish(serverId, entry, settled);
    }
    const current = () => !read.controller.signal.aborted && entry.lifetime.isCurrent() && entry.read === read;
    void createMachinePresetCollectionClient(entry.lifetime.scope, entry.homeId).list({
        signal: read.controller.signal,
        onApprovalPending: approval => {
            if (!current()) return;
            read.awaitingApproval = true;
            publish(serverId, entry, { ...entry.snapshot, approval });
            for (const consumer of entry.consumers) consumer.onApprovalPending?.(approval);
        },
        onApprovalSettled: () => { read.awaitingApproval = false; },
    }).then(result => {
        if (!current()) return;
        entry.read = null;
        publish(serverId, entry, {
            value: result.kind === 'succeeded' ? retainKeyedRows(entry.snapshot.value, result.value, preset => preset.id)
                : isMachinePresetAccessLost(result.code) ? null : entry.snapshot.value,
            loading: false,
            error: result.kind === 'failed' ? result.code : null,
        });
    }).catch(() => {
        if (!current()) return;
        entry.read = null;
        publish(serverId, entry, { value: entry.snapshot.value, loading: false, error: 'request_failed' });
    }).finally(() => {
        if (entry.read === read) entry.read = null;
    });
}

export function invalidateMachinePresets(serverId: string): void {
    const id = scopeId(serverId);
    const entry = entries.get(id);
    // An approved read has not executed yet; its eventual answer covers this change.
    if (!entry || entry.read?.awaitingApproval) return;
    entry.stale = true;
    entry.read?.controller.abort();
    entry.read = null;
    load(id, entry);
}

function reconcileObservation() {
    if (entries.size > 0 && !stopObserving) {
        // Retained rows hear changes on existing connections even between page visits.
        stopObserving = subscribeHomeAccountChange(event => {
            if (event.source === 'snapshot'
                || event.entityIds?.includes(MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1)
                || event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) invalidateMachinePresets(event.serverId);
        });
    } else if (entries.size === 0) {
        stopObserving?.();
        stopObserving = undefined;
    }
    const homes = [...entries].filter(([, entry]) => entry.consumers.size > 0).map(([id]) => id).sort();
    const key = JSON.stringify(homes);
    if (key === demandedHomes) return;
    stopDemanding?.();
    const readNotCurrent = (entry: Entry | undefined) => !!entry && entry.read === null
        && (entry.snapshot.value === null || entry.snapshot.error !== null);
    // The incumbent reconnect owner retries failed reads; settled content follows the feed.
    stopDemanding = homes.length ? subscribeHomeAccountChange(event => {
        if (event.source === 'connected' && readNotCurrent(entries.get(scopeId(event.serverId)))) {
            invalidateMachinePresets(event.serverId);
        }
    }, { serverIds: homes, reconnect: { readNotCurrent: () => homes.some(id => readNotCurrent(entries.get(id))) } }) : undefined;
    demandedHomes = key;
}

function retire(serverId: string, entry: Entry) {
    entry.read?.controller.abort();
    entry.retirement.dispose();
    if (entries.get(serverId) !== entry) return;
    entries.delete(serverId);
    reconcileObservation();
    notify(serverId);
}

/** Account-owned settled content survives page bindings; credential retirement withdraws it synchronously. */
export function retainMachinePresets(lifetime: ServerAccountScopeLifetime, homeId: string,
    onApprovalPending?: (approval: ActionApprovalRegistration) => void): () => void {
    const owner = readServerAccountScopeOwnerLifetime(lifetime);
    if (!owner.isCurrent()) return () => {};
    const id = scopeId(owner.scope.serverId);
    let entry = entries.get(id);
    if (entry && (entry.homeId !== homeId || entry.lifetime !== owner)) {
        retire(id, entry);
        entry = undefined;
    }
    if (!entry) {
        const created: Entry = { lifetime: owner, homeId, snapshot: empty, consumers: new Set(),
            retirement: { dispose() {} }, read: null, stale: true };
        entries.set(id, created);
        created.retirement = owner.onRetire(() => retire(id, created));
        entry = created;
    }
    const retained = entry;
    const consumer: Consumer = { onApprovalPending };
    retained.consumers.add(consumer);
    reconcileObservation();
    load(id, retained);
    if (retained.snapshot.approval) onApprovalPending?.(retained.snapshot.approval);
    return () => {
        retained.consumers.delete(consumer);
        if (retained.consumers.size === 0 && retained.read) {
            retained.read.controller.abort();
            retained.read = null;
            retained.stale = true;
        }
        reconcileObservation();
    };
}

export function readMachinePresetsSnapshot(serverId: string, homeId: string, accountId?: string): Snapshot {
    const entry = entries.get(scopeId(serverId));
    return entry?.lifetime.isCurrent() && entry.homeId === homeId
        && getServerProfileById(serverId)?.serverIdentityId === homeId
        && (accountId === undefined || entry.lifetime.scope.accountId === accountId) ? entry.snapshot : empty;
}

export function subscribeMachinePresets(serverIds: readonly string[], listener: () => void): () => void {
    const ids = [...new Set(serverIds.map(scopeId))];
    for (const id of ids) {
        const subscriptions = listeners.get(id) ?? new Set();
        subscriptions.add(listener);
        listeners.set(id, subscriptions);
    }
    return () => {
        for (const id of ids) {
            const subscriptions = listeners.get(id);
            subscriptions?.delete(listener);
            if (subscriptions?.size === 0) listeners.delete(id);
        }
    };
}

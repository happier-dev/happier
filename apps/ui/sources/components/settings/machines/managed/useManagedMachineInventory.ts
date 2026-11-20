import { openManagedMachineReadSnapshots } from '@/sync/ops/machines/machinePresetCollectionClient';
import * as React from 'react';
import { useLayoutPresentationSignal, type LayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';

import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeStates, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { isManagedMachineResourceAbsent } from './managedMachineResource';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const execute = createFrontDoorActionExecute();
const EMPTY_ROWS: readonly ManagedMachineV1[] = [];
type InventoryExecute = ReturnType<typeof createDefaultActionExecutor>['execute'];

export type ManagedMachineInventoryEntry = Readonly<{
    accountId: string;
    homeId?: string;
    managedId?: string;
    enrolledMachineId?: string;
    includeArchived?: boolean;
    machines: readonly ManagedMachineV1[];
    status: 'loading' | 'ready' | 'error' | 'unsupported' | 'denied' | 'missing';
    errorCode?: string;
    asOf?: number;
    approval?: ActionApprovalRegistration;
}>;

type InventoryReader = ReturnType<typeof createInventoryReader>;
type InventoryReceipt = Readonly<{ entry: ManagedMachineInventoryEntry; observedChange: number | undefined }>;
// The last reader releases transport and observation. Admitted presentation
// survives route remounts within the incumbent Account lifetime, without demand.
type InventoryDemand = { readers: Map<string, InventoryReader>; observers: Set<() => void>;
    retained: WeakMap<ServerAccountScopeLifetime, Map<string, InventoryReceipt>>; unsubscribe?: () => void;
    /**
     * Per Home, how many inventory changes were pushed; a retained receipt notes the count it was read at. A receipt
     * with no change pushed since is current, so re-taking it (each return to a page hidden through Activity) reads nothing.
     */
    changes: Map<string, number> };
const demandedInventories = new WeakMap<InventoryExecute, InventoryDemand>();

function inventoryDemand(executeAction: InventoryExecute): InventoryDemand {
    let demand = demandedInventories.get(executeAction);
    if (!demand) {
        demand = { readers: new Map(), observers: new Set(), retained: new WeakMap(), changes: new Map() };
        demandedInventories.set(executeAction, demand);
    }
    return demand;
}

function inventoryKey(serverId: string, accountId: string | undefined, homeId: string | null | undefined, managedId: string | undefined, includeArchived: boolean, enrolledMachineId?: string): string {
    return JSON.stringify([serverId, accountId, homeId, managedId, includeArchived, enrolledMachineId]);
}

/** Exact authorized reads patch membership; broad receipts only replace already admitted rows. */
function receivedMachineRows(entry: ManagedMachineInventoryEntry, rows: ReadonlyMap<string, ManagedMachineV1>,
    absent: ReadonlyMap<string, string> = new Map(), admitMembership = false) {
    const selected = (machine: ManagedMachineV1) => (!entry.managedId || entry.managedId === machine.id)
        && (Boolean(entry.managedId) || entry.includeArchived || machine.archivedAt === undefined)
        && (!entry.enrolledMachineId || entry.enrolledMachineId === machine.enrolledMachineId);
    const machines = entry.machines.flatMap(previous => {
        const machine = rows.get(previous.id) ?? previous;
        return !absent.has(previous.id) && selected(machine) ? [machine] : [];
    });
    if (admitMembership) {
        const existing = new Set(entry.machines.map(machine => machine.id));
        for (const machine of rows.values()) if (!existing.has(machine.id) && selected(machine)) machines.push(machine);
    }
    return machines;
}

/** One invalidation owner per executor; each demanded Account reads each changed id once. */
function observeInventoryChanges(demand: InventoryDemand) {
    return subscribeHomeAccountChange(event => {
        const serverId = resolveServerProfileScopeIdForIdentifier(event.serverId) || event.serverId;
        // Any change that can reach an inventory or one of its rows outdates retained receipts for this Home.
        if (event.managedMachineChangedIds?.length !== 0
            && (event.managedMachineInventoryAffect !== false || event.machineResourcesAffect !== false)) {
            demand.changes.set(serverId, (demand.changes.get(serverId) ?? 0) + 1);
        }
        const groups = new Map<string, InventoryReader[]>();
        for (const reader of demand.readers.values()) {
            if (!reader.isCurrent() || reader.serverId !== serverId || reader.isAwaitingApproval()) continue;
            const entry = reader.get();
            if (entry.managedId
                ? event.managedMachineChangedIds === undefined && event.machineResourcesAffect === false
                : event.managedMachineInventoryAffect === false) continue;
            const key = JSON.stringify([entry.accountId, entry.homeId]);
            const group = groups.get(key) ?? [];
            group.push(reader);
            groups.set(key, group);
        }
        for (const group of groups.values()) {
            if (event.managedMachineChangedIds !== undefined) {
                if (event.managedMachineChangedIds.length === 0) continue;
                const inventory = group.find(reader => !reader.get().managedId && reader.get().status === 'ready');
                if (inventory) void inventory.refresh(event.managedMachineChangedIds);
                else for (const reader of group) {
                    const id = reader.get().managedId;
                    if (id && event.managedMachineChangedIds.includes(id)) void reader.refresh([id]);
                    else if (!id) void reader.refresh();
                }
            } else for (const reader of group) {
                if (event.source === 'connected' && event.changesCatchUp && reader.get().status === 'ready') continue;
                void reader.refresh();
            }
        }
    }, { reconnect: 'refresh' });
}

/** An entry field set to undefined is the field being absent. */
function definedFields(entry: ManagedMachineInventoryEntry): ManagedMachineInventoryEntry {
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as ManagedMachineInventoryEntry;
}

function createInventoryReader(serverId: string, accountId: string, homeId: string, managedId: string | undefined,
    includeArchived: boolean, executeAction: InventoryExecute, remove: () => void, onPublished: () => void, readHomeChange: () => number,
    retained?: InventoryReceipt,
    enrolledMachineId?: string, admitted = false, onRead?: (machines: readonly ManagedMachineV1[], absent?: ReadonlyMap<string, string>, admitMembership?: boolean) => void,
    joinedInitialRead = false) {
    const consumers = new Map<() => void, ServerAccountScopeLifetime>();
    const previousEntry = retained?.entry;
    let entry: ManagedMachineInventoryEntry = definedFields({ accountId, homeId, managedId, enrolledMachineId, includeArchived,
        machines: previousEntry?.machines ?? EMPTY_ROWS, ...(previousEntry?.asOf !== undefined ? { asOf: previousEntry.asOf } : {}),
        status: admitted ? 'ready' : 'loading' });
    let observedChange = retained?.observedChange;
    let machinesById = new Map(entry.machines.map(machine => [machine.id, machine]));
    let machinesByEnrolledId = new Map(entry.machines.flatMap(machine => machine.enrolledMachineId && machine.archivedAt === undefined
        ? [[machine.enrolledMachineId, machine] as const] : []));
    let controller: AbortController | null = null;
    const pendingRowIds = new Set<string>();
    let refreshing = false;
    let awaitingApproval = false;
    let disposed = false;
    const isCurrent = () => !disposed && getServerProfileById(serverId)?.serverIdentityId === homeId
        && [...consumers.values()].some(binding => binding.isCurrent());
    const publish = (next: ManagedMachineInventoryEntry) => {
        // One entry shape whichever read answered (a row re-read clears `errorCode: undefined`, a list read omits it), so
        // an equal receipt from a different read is still an equal receipt.
        next = definedFields({ ...next, machines: retainKeyedRows(entry.machines, next.machines, machine => machine.id) });
        // asOf marks that this reader has answered. A later equal receipt is
        // not a changed inventory fact; first admission still publishes it.
        if (entry.asOf !== undefined && next.asOf !== undefined && retainShallow(entry, { ...next, asOf: entry.asOf }) === entry) return;
        if (retainShallow(entry, next) === entry) return;
        if (next.machines !== entry.machines) {
            machinesById = new Map(next.machines.map(machine => [machine.id, machine]));
            machinesByEnrolledId = new Map(next.machines.flatMap(machine => machine.enrolledMachineId && machine.archivedAt === undefined
                ? [[machine.enrolledMachineId, machine] as const] : []));
        }
        entry = next;
        for (const listener of consumers.keys()) listener();
        onPublished();
    };
    const refresh = (changedIds?: readonly string[]) => {
        if (!isCurrent()) return;
        if (changedIds) {
            for (const id of changedIds) pendingRowIds.add(id);
            if (refreshing) return;
            changedIds = [...pendingRowIds];
        }
        pendingRowIds.clear();
        refreshing = true;
        controller?.abort();
        const cancellation = new AbortController();
        controller = cancellation;
        const readChange = readHomeChange();
        awaitingApproval = false;
        // Revalidation keeps the settled answer, including failures, until it
        // changes. Initial loading and pending approval have their own transitions.
        return (async () => {
                try {
                    type ReadResult = Readonly<{ kind: 'succeeded'; machines: ManagedMachineV1[] }> | Readonly<{ kind: 'failed'; code: string }>;
                    type ReadOutput = ManagedMachineActionOutputV1<'machines.managed.get'> | ManagedMachineActionOutputV1<'machines.managed.list'>;
                    const openRead = (value: ReadOutput) => openManagedMachineReadSnapshots({ serverId, accountId },
                        'machines' in value ? value.machines : [value], cancellation.signal);
                    const read = (input: { homeId: string; managedId?: string; archived?: boolean; enrolledMachineId?: string }) => awaitActionApprovalResult<ManagedMachineV1[], ReadResult>({
                        signal: cancellation.signal,
                        execute: async callbacks => {
                            const actionId = input.managedId ? 'machines.managed.get' : 'machines.managed.list';
                            const outcome = classifyHomeActionOutcome(await executeAction(actionId, input, { surface: 'ui', serverId,
                                    expectedAccountId: accountId, signal: cancellation.signal }));
                            if (!isCurrent() || cancellation.signal.aborted) return { kind: 'failed', code: 'aborted' };
                            if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                            if (outcome.kind === 'approval_pending') {
                                awaitingApproval = true;
                                const approval = createActionApprovalContinuation<ReadOutput, typeof actionId>({
                                    artifactId: outcome.artifactId, actionId, scope: { serverId, accountId }, expectedInput: input,
                                    signal: cancellation.signal,
                                    onSucceeded: async value => callbacks.onApprovalSucceeded(await openRead(value)),
                                    onFailed: callbacks.onApprovalFailed,
                                });
                                if (isCurrent() && !cancellation.signal.aborted) publish({ ...entry, status: 'loading', errorCode: undefined, approval });
                                return { approvalPending: true };
                            }
                            // The Action terminal owner already admitted this output; inventory consumes its typed receipt.
                            const machines = await openRead(outcome.result as ReadOutput);
                            return { kind: 'succeeded', machines };
                        },
                        succeeded: machines => ({ kind: 'succeeded', machines }), failed: code => ({ kind: 'failed', code }),
                        aborted: () => ({ kind: 'failed', code: 'aborted' }),
                    });
                    if (changedIds) {
                        const machines: ManagedMachineV1[] = [];
                        const absent = new Map<string, string>();
                        for (const id of changedIds) {
                            const result = await read({ homeId, managedId: id });
                            if (cancellation.signal.aborted || !isCurrent()) return;
                            if (result.kind === 'failed') {
                                if (result.code === 'managed_not_found' || result.code === 'permission_denied') absent.set(id, result.code);
                                else {
                                    const { approval: _approval, ...previous } = entry;
                                    publish({ ...previous, status: 'error', errorCode: result.code });
                                    return;
                                }
                            } else {
                                if (result.machines.some(machine => machine.homeId !== homeId || machine.id !== id)) throw new Error('managed_response_invalid');
                                machines.push(...result.machines);
                            }
                        }
                        awaitingApproval = false;
                        observedChange = readChange;
                        receiveRows(new Map(machines.map(machine => [machine.id, machine])), absent, true, true);
                        onRead?.(machines, absent, true);
                        return;
                    }
                    const listInput = { homeId, ...(enrolledMachineId ? { enrolledMachineId } : {}) };
                    let result = await read(managedId ? { homeId, managedId } : listInput);
                    if (cancellation.signal.aborted || !isCurrent()) return;
                    awaitingApproval = false;
                    if (!managedId && includeArchived && result.kind === 'succeeded') {
                        // The active list has answered even while archive recovery is pending. Publish
                        // that receipt so collection first-load readiness follows the admitted rows.
                        // Keep previous recovery rows until the second read settles.
                        const active = result.machines;
                        if (active.some(machine => machine.homeId !== homeId)) throw new Error('managed_response_invalid');
                        // A joined current-only reader can use this first active answer.
                        if (entry.asOf === undefined) observedChange = readChange;
                        publish({ ...entry, asOf: Date.now(), machines:
                            [...new Map([...active, ...entry.machines.filter(machine => machine.archivedAt !== undefined)]
                                .map(machine => [machine.id, machine])).values()] });
                        const archived = await read({ ...listInput, archived: true });
                        if (cancellation.signal.aborted || !isCurrent()) return;
                        awaitingApproval = false;
                        result = archived.kind === 'failed' ? archived : { kind: 'succeeded', machines:
                            [...new Map([...result.machines, ...archived.machines].map(machine => [machine.id, machine])).values()] };
                    }
                    if (!isCurrent() || cancellation.signal.aborted) return;
                    if (result.kind === 'failed') {
                        const code = result.code;
                        const denied = code === 'permission_denied' || code === 'not_authenticated' || code === 'action_account_scope_changed';
                        const status = denied ? 'denied' : code === 'managed_not_found' ? 'missing' : code === 'unsupported_action' ? 'unsupported' : 'error';
                        const { approval: _approval, ...previous } = entry;
                        publish({ ...previous, status, errorCode: code,
                            ...(status === 'denied' || status === 'missing' ? { machines: EMPTY_ROWS, asOf: undefined } : {}) });
                        return;
                    }
                    const machines = result.machines;
                    if (machines.some(machine => machine.homeId !== homeId || (managedId && machine.id !== managedId)
                        || (enrolledMachineId && machine.enrolledMachineId !== enrolledMachineId))) throw new Error('managed_response_invalid');
                    // An equal result still settles the read. Publication may reuse the entry's identity.
                    observedChange = readChange;
                    publish({ accountId, homeId, managedId, enrolledMachineId, includeArchived, status: 'ready', asOf: Date.now(), machines });
                    onRead?.(machines);
                } catch {
                    if (!isCurrent() || cancellation.signal.aborted) return;
                    const { approval: _approval, ...previous } = entry;
                    publish({ ...previous, status: 'error', errorCode: 'managed_request_failed' });
                } finally {
                    if (controller === cancellation) {
                        awaitingApproval = false;
                        refreshing = false;
                        if (pendingRowIds.size) void refresh([...pendingRowIds]);
                    }
                }
            })();
    };
    const receiveRows = (rows: ReadonlyMap<string, ManagedMachineV1>, absent: ReadonlyMap<string, string> = new Map(), admitMembership = false, settled = false) => {
        if (awaitingApproval || (!settled && (entry.status === 'denied' || entry.status === 'missing' || entry.status === 'unsupported'))) return;
        const { approval: _approval, ...withoutApproval } = entry;
        const previous = settled ? withoutApproval : entry;
        const code = managedId ? absent.get(managedId) : undefined;
        publish({ ...previous, machines: receivedMachineRows(entry, rows, absent, admitMembership),
            ...(code ? { status: code === 'permission_denied' ? 'denied' as const : 'missing' as const, errorCode: code, asOf: undefined }
                : settled ? { status: 'ready' as const, errorCode: undefined, asOf: Date.now() } : {}) });
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller?.abort();
        remove();
    };
    return {
        serverId,
        isAwaitingApproval: () => awaitingApproval,
        isRefreshing: () => refreshing,
        get: () => entry,
        getObservedChange: () => observedChange,
        getMachine: (id: string) => machinesById.get(id),
        getEnrolledMachine: (id: string) => machinesByEnrolledId.get(id),
        isCurrent,
        refresh,
        /** First answer of a joined reader: the joined list read's current rows. */
        admitJoinedReceipt(machines: readonly ManagedMachineV1[], joinedChange: number | undefined) {
            if (!isCurrent() || entry.asOf !== undefined || refreshing) return;
            observedChange = joinedChange;
            publish({ ...entry, status: 'ready', errorCode: undefined, asOf: Date.now(), machines });
        },
        receiveRows(sourceServerId: string, sourceAccountId: string, sourceHomeId: string, rows: ReadonlyMap<string, ManagedMachineV1>,
            absent?: ReadonlyMap<string, string>, admitMembership = false) {
            if (sourceServerId !== serverId || sourceAccountId !== accountId || sourceHomeId !== homeId
                || !isCurrent()) return;
            // Only an exact authorized receipt for this selection settles its
            // readiness. Broad rows and another selection's read remain projections.
            const settled = admitMembership && managedId !== undefined && (rows.has(managedId) || absent?.has(managedId) === true);
            receiveRows(rows, absent, admitMembership, settled);
        },
        subscribe(binding: ServerAccountScopeLifetime, listener: () => void) {
            consumers.set(listener, binding);
            const release = () => {
                consumers.delete(listener);
                if (![...consumers.values()].some(current => current.isCurrent())) dispose();
            };
            const retirement = binding.onRetire(release);
            listener();
            // A joined reader takes its first answer from the in-flight read it joined (see getInventoryReader).
            if (controller === null && !admitted && !joinedInitialRead) refresh();
            return () => { retirement.dispose(); release(); };
        },
    };
}

function getInventoryReader(serverId: string, accountId: string, homeId: string, managedId: string | undefined,
    includeArchived: boolean, executeAction: InventoryExecute, current?: ManagedMachineInventoryEntry, enrolledMachineId?: string): InventoryReader {
    const demand = inventoryDemand(executeAction);
    const inventories = demand.readers;
    const key = inventoryKey(serverId, accountId, homeId, managedId, includeArchived, enrolledMachineId);
    const lifetime = captureActiveServerAccountScopeLifetime();
    const readHomeChange = () => demand.changes.get(serverId) ?? 0;
    let reader = inventories.get(key);
    const notify = () => {
        if (lifetime?.isCurrent() && reader) {
            const retained = demand.retained.get(lifetime) ?? new Map<string, InventoryReceipt>();
            const entry = reader.get();
            if (entry.asOf !== undefined && !entry.approval) {
                retained.set(key, { entry, observedChange: reader.getObservedChange() });
            } else {
                retained.delete(key);
            }
            demand.retained.set(lifetime, retained);
        }
        if (!managedId) for (const observer of demand.observers) observer();
    };
    if (!reader?.isCurrent()) {
        const cached = lifetime?.isCurrent() ? demand.retained.get(lifetime)?.get(key) : undefined;
        let retained = cached ?? (current?.accountId === accountId && current.homeId === homeId && current.managedId === managedId
            && current.enrolledMachineId === enrolledMachineId && (current.includeArchived ?? false) === includeArchived
            ? { entry: current, observedChange: undefined } : undefined);
        let joined: InventoryReader | undefined;
        if (!managedId && !includeArchived && !enrolledMachineId && !retained) {
            // The archive-including inventory already read the current list. A settled
            // receipt admits its current rows; later wakes refresh this reader itself.
            const inventory = inventories.get(inventoryKey(serverId, accountId, homeId, undefined, true));
            const receipt = inventory?.isCurrent() && !inventory.isRefreshing() ? inventory.get() : undefined;
            if (receipt?.status === 'ready' && receipt.asOf !== undefined) {
                retained = { entry: { ...receipt, includeArchived: false, machines: receipt.machines.filter(machine => machine.archivedAt === undefined) },
                    observedChange: inventory?.getObservedChange() };
            } else if (inventory?.isCurrent() && inventory.isRefreshing() && inventory.get().asOf === undefined) {
                // Its first list read is in flight (screens mounting together): join it instead of reading the same list again.
                joined = inventory;
            }
        }
        if (enrolledMachineId && !retained) {
            for (const archived of [false, true]) {
                const inventory = inventories.get(inventoryKey(serverId, accountId, homeId, undefined, archived));
                const receipt = inventory?.isCurrent() ? inventory.get() : undefined;
                const machine = receipt?.status === 'ready' ? inventory?.getEnrolledMachine(enrolledMachineId) : undefined;
                if (!machine || !receipt) continue;
                // Reuse admission without retaining broad list demand. Future invalidation
                // is handled by this reader's exact enrolled-Machine query.
                retained = { entry: { ...receipt, managedId, enrolledMachineId, includeArchived, machines: [machine] },
                    observedChange: inventory?.getObservedChange() };
                break;
            }
        }
        // Reuse a settled observation only when it includes the latest Home change.
        const admitted = retained?.entry.status === 'ready' && retained.observedChange === readHomeChange();
        reader = createInventoryReader(serverId, accountId, homeId, managedId, includeArchived, executeAction,
            () => { if (inventories.get(key) === reader) {
                inventories.delete(key);
                // The change observation stays while receipts are retained, so a released inventory knows whether
                // it changed while away; it is one listener per inventory demand.
                notify();
            } }, notify, readHomeChange, retained, enrolledMachineId, admitted,
            (machines, absent, admitMembership) => {
                const rows = new Map(machines.map(machine => [machine.id, machine]));
                // A retained destination may remount before its next read settles.
                // Give it the same admitted rows as live projections, so an old
                // enrollment cannot redirect back from a confirmed-absent receipt.
                const receipts = lifetime?.isCurrent() ? demand.retained.get(lifetime) : undefined;
                for (const [receiptKey, retainedReceipt] of receipts ?? []) {
                    const receipt = retainedReceipt.entry;
                    if (receipt.accountId !== accountId || receipt.homeId !== homeId) continue;
                    const received = retainKeyedRows(receipt.machines, receivedMachineRows(receipt, rows, absent, admitMembership), machine => machine.id);
                    if (received !== receipt.machines) receipts?.set(receiptKey, { ...retainedReceipt, entry: { ...receipt, machines: received } });
                }
                for (const target of inventories.values()) if (target !== reader) target.receiveRows(serverId, accountId, homeId, rows, absent, admitMembership);
            }, joined !== undefined);
        inventories.set(key, reader);
        if (joined) {
            const source = joined;
            const joining = reader;
            // One-shot: the joined read's first answer (its current rows) settles this reader; if that
            // read ends without an answer, this reader reads for itself.
            const settle = () => {
                if (!joining.isCurrent()) { demand.observers.delete(settle); return; }
                const answer = source.isCurrent() ? source.get() : undefined;
                if (answer?.asOf !== undefined && (answer.status === 'ready' || answer.status === 'loading')) {
                    demand.observers.delete(settle);
                    joining.admitJoinedReceipt(answer.machines.filter(machine => machine.archivedAt === undefined), source.getObservedChange());
                } else if (!answer || (answer.status !== 'loading' && answer.status !== 'ready')) {
                    demand.observers.delete(settle);
                    void joining.refresh();
                }
            };
            demand.observers.add(settle);
        }
        demand.unsubscribe ??= observeInventoryChanges(demand);
    }
    return reader;
}

/** Borrow the same active inventory as the host hook; the last current consumer releases its read and observation. */
export function retainManagedMachineInventory(lifetime: ServerAccountScopeLifetime, listener: (entry: ManagedMachineInventoryEntry) => void,
    selection?: Readonly<{ managedId?: string; enrolledMachineId?: string }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId) || lifetime.scope.serverId;
    const homeId = getServerProfileById(serverId)?.serverIdentityId;
    if (!homeId || !lifetime.isCurrent()) throw Object.assign(new Error('Managed inventory Account is unavailable'), { code: 'plugin_resource_unavailable' });
    const reader = getInventoryReader(serverId, lifetime.scope.accountId, homeId, selection?.managedId, false, execute,
        undefined, selection?.enrolledMachineId);
    const release = reader.subscribe(lifetime, () => listener(reader.get()));
    return { getSnapshot: reader.get, getMachine: reader.getMachine, getEnrolledMachine: reader.getEnrolledMachine,
        refresh: reader.refresh, dispose: release };
}

/** Observe only admitted resource absence, without starting or retaining list demand. */
export function useAdmittedManagedMachineAbsentEnrolledIds(serverId: string, binding: ServerCredentialAccountScopeBinding | null | undefined,
    executeAction: InventoryExecute = execute): ReadonlySet<string> {
    const demand = React.useMemo(() => inventoryDemand(executeAction), [executeAction]);
    const scopedServerId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
    const homeId = getServerProfileById(scopedServerId)?.serverIdentityId;
    const subscribe = React.useCallback((listener: () => void) => {
        demand.observers.add(listener);
        return () => { demand.observers.delete(listener); };
    }, [demand]);
    const snapshot = React.useCallback(() => {
        if (!binding?.isCurrent() || !homeId) return '[]';
        for (const includeArchived of [false, true]) {
            const reader = demand.readers.get(inventoryKey(scopedServerId, binding.accountId, homeId, undefined, includeArchived));
            const entry = reader?.isCurrent() ? reader.get() : undefined;
            // A cold narrower reader has no admitted empty census. Keep using the
            // already-demanded receipt until that reader actually answers.
            if (entry?.asOf !== undefined) return JSON.stringify(entry.machines.flatMap(machine =>
                machine.archivedAt === undefined && machine.enrolledMachineId && isManagedMachineResourceAbsent(machine) ? [machine.enrolledMachineId] : []).sort());
        }
        return '[]';
    }, [binding, demand, homeId, scopedServerId]);
    const absentIds = React.useSyncExternalStore(subscribe, snapshot, () => '[]');
    return React.useMemo(() => new Set(JSON.parse(absentIds) as string[]), [absentIds]);
}

/** Observe an addressed row already admitted by a demanded list; never start or retain list demand. */
export function useAdmittedManagedMachineRow(serverId: string, managedId: string, binding: ServerCredentialAccountScopeBinding | undefined,
    executeAction: InventoryExecute = execute): ManagedMachineV1 | undefined {
    const demand = React.useMemo(() => inventoryDemand(executeAction), [executeAction]);
    const homeId = getServerProfileById(serverId)?.serverIdentityId;
    const subscribe = React.useCallback((listener: () => void) => {
        demand.observers.add(listener);
        return () => { demand.observers.delete(listener); };
    }, [demand]);
    const snapshot = React.useCallback(() => {
        if (!binding?.isCurrent() || !homeId) return undefined;
        for (const includeArchived of [false, true]) {
            const reader = demand.readers.get(inventoryKey(serverId, binding.accountId, homeId, undefined, includeArchived));
            const machine = reader?.isCurrent() ? reader.getMachine(managedId) : undefined;
            if (machine) return machine;
        }
        return undefined;
    }, [binding, demand, homeId, managedId, serverId]);
    return React.useSyncExternalStore(subscribe, snapshot, () => undefined);
}

function subscribePresentedInventory(signal: LayoutPresentationSignal, start: (presented: boolean) => (() => void) | void) {
    let current = signal.get();
    let stop = start(current);
    const unsubscribe = signal.subscribe(() => {
        if (signal.get() === current) return;
        current = signal.get();
        stop?.();
        stop = start(current);
    });
    return () => { unsubscribe(); stop?.(); };
}

export type ManagedMachineMembershipInput = Readonly<{
    machines: readonly ManagedMachineV1[] | undefined;
    firstAnswerPending: boolean;
}>;

/** The collection's selected snapshots can read the shared receipt without subscribing React to the full entry. */
export function useHomeManagedMachineMembershipSource(serverId: string | undefined) {
    const presented = useLayoutPresentationSignal();
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = serverId && getServerProfileById(serverId)?.serverIdentityId;
    return React.useMemo(() => {
        const demand = inventoryDemand(execute);
        const key = inventoryKey(serverId ?? '', binding?.accountId, homeId, undefined, true);
        const read = (): ManagedMachineMembershipInput => {
            if (!homeId || !binding?.isCurrent()) {
                return { machines: undefined, firstAnswerPending: Boolean(homeId && resolution.kind === 'resolving') };
            }
            const reader = demand.readers.get(key);
            const live = reader?.isCurrent() ? reader.get() : undefined;
            const lifetime = live ? null : captureActiveServerAccountScopeLifetime();
            const entry = live ?? (lifetime?.isCurrent() ? demand.retained.get(lifetime)?.get(key)?.entry : undefined);
            return { machines: entry?.machines,
                firstAnswerPending: entry?.asOf === undefined && (!entry || entry.status === 'loading') };
        };
        const subscribe = (listener: () => void) => subscribePresentedInventory(presented, visible => {
            if (!visible || !serverId || !homeId || !binding?.isCurrent()) return;
            const reader = getInventoryReader(serverId, binding.accountId, homeId, undefined, true, execute);
            return reader.subscribe(binding, listener);
        });
        return { read, subscribe };
    }, [binding, homeId, presented, resolution.kind, serverId]);
}

/** A demanded projection of the canonical server inventory, with no persisted UI resource state. */
export function useManagedMachineInventory<TExecute extends InventoryExecute = FrontDoorActionExecute>(serverIds: readonly string[], managedId?: string,
    requestedExecuteAction?: TExecute, includeArchived = false, enrolledMachineId?: string) {
    const presentedSignal = useLayoutPresentationSignal();
    const executeAction = requestedExecuteAction ?? execute;
    const idsKey = JSON.stringify([...new Set(serverIds.map(id => resolveServerProfileScopeIdForIdentifier(id) || id))].sort());
    const requestedIdsKey = JSON.stringify(serverIds);
    const ids = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const accountScopes = useServerCredentialAccountScopeStates(ids);
    const bindings = React.useMemo(() => new Map([...accountScopes].flatMap(([serverId, state]) => state.binding ? [[serverId, state.binding] as const] : [])), [accountScopes]);
    const [entries, setEntries] = React.useState<Readonly<Record<string, ManagedMachineInventoryEntry>>>({});
    const reads = React.useRef(new Map<string, { binding: ServerCredentialAccountScopeBinding; key: string;
        executeAction: InventoryExecute; reader: InventoryReader; release(): void }>());
    const refreshAll = React.useCallback(() => {
        for (const { reader } of reads.current.values()) reader.refresh();
    }, []);
    React.useEffect(() => () => {
        for (const read of reads.current.values()) read.release();
        reads.current.clear();
    }, []);
    React.useEffect(() => {
        // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
        const start = (presented: boolean): (() => void) | void => {
            const keys = new Map(ids.map(serverId => [serverId, inventoryKey(
                serverId, bindings.get(serverId)?.accountId, getServerProfileById(serverId)?.serverIdentityId, managedId, includeArchived, enrolledMachineId,
            )]));
            for (const [serverId, read] of reads.current) {
                if (presented && read.binding === bindings.get(serverId) && read.binding.isCurrent() && read.reader.isCurrent()
                    && read.key === keys.get(serverId) && read.executeAction === executeAction) continue;
                read.release(); reads.current.delete(serverId);
            }
            for (const serverId of ids) {
                const binding = bindings.get(serverId);
                const homeId = getServerProfileById(serverId)?.serverIdentityId;
                if (!presented || !binding?.isCurrent() || !homeId || reads.current.has(serverId)) continue;
                const key = keys.get(serverId)!;
                const reader = getInventoryReader(serverId, binding.accountId, homeId, managedId, includeArchived, executeAction, entries[serverId], enrolledMachineId);
                const ownedReader = reader;
                const release = reader.subscribe(binding, () => setEntries(previous => previous[serverId] === ownedReader.get()
                    ? previous : { ...previous, [serverId]: ownedReader.get() }));
                reads.current.set(serverId, { binding, key, executeAction, reader, release });
            }
            // Entry updates are projections, not new demand. Only binding/target changes reacquire a reader.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        };
        return subscribePresentedInventory(presentedSignal, start);
    }, [bindings, ids, managedId, includeArchived, enrolledMachineId, executeAction, presentedSignal]);

    const currentEntries = React.useMemo(() => {
        const result: Record<string, ManagedMachineInventoryEntry> = {};
        const lifetime = captureActiveServerAccountScopeLifetime();
        const retained = lifetime?.isCurrent() ? inventoryDemand(executeAction).retained.get(lifetime) : undefined;
        for (const serverId of ids) {
            const binding = bindings.get(serverId);
            const resolution = accountScopes.get(serverId)?.resolution.kind;
            // Pending credential acquisition may borrow the active Account's display
            // receipt. Execution still requires the fresh binding and read below.
            const accountId = binding?.isCurrent() ? binding.accountId
                : (!resolution || resolution === 'resolving') && lifetime?.scope.serverId === serverId ? lifetime.scope.accountId : undefined;
            const cached = accountId ? retained?.get(inventoryKey(serverId, accountId,
                getServerProfileById(serverId)?.serverIdentityId, managedId, includeArchived, enrolledMachineId))?.entry : undefined;
            const entry = entries[serverId] ?? (cached ? { ...cached, status: 'loading' as const } : undefined);
            if (accountId && entry?.accountId === accountId && entry.managedId === managedId && entry.enrolledMachineId === enrolledMachineId
                && entry.homeId === getServerProfileById(serverId)?.serverIdentityId
                && (entry.includeArchived ?? false) === includeArchived) result[serverId] = entry;
        }
        return result;
    }, [accountScopes, bindings, entries, ids, managedId, includeArchived, enrolledMachineId, executeAction]);

    const previousDisplay = React.useRef<{
        machinesByServerId: Readonly<Record<string, readonly ManagedMachineV1[]>>;
        machinesByEnrolledMachineIdByServerId: Readonly<Record<string, Readonly<Record<string, ManagedMachineV1>>>>;
    }>({ machinesByServerId: {}, machinesByEnrolledMachineIdByServerId: {} });
    const { machinesByServerId, machinesByEnrolledMachineIdByServerId } = React.useMemo(() => {
        const previous = previousDisplay.current;
        const rows = Object.fromEntries<readonly ManagedMachineV1[]>((JSON.parse(requestedIdsKey) as string[]).map(serverId => [serverId,
            currentEntries[resolveServerProfileScopeIdForIdentifier(serverId) || serverId]?.machines ?? EMPTY_ROWS,
        ]));
        const machinesByServerId = retainShallow(previous.machinesByServerId, rows);
        if (machinesByServerId === previous.machinesByServerId) return previous;
        const enrolled = Object.fromEntries<Readonly<Record<string, ManagedMachineV1>>>(Object.entries(machinesByServerId).map(([serverId, machines]) => {
            const retained = previous.machinesByEnrolledMachineIdByServerId[serverId];
            if (retained && machines === previous.machinesByServerId[serverId]) return [serverId, retained];
            const index = Object.fromEntries<ManagedMachineV1>(machines.flatMap(machine =>
                machine.archivedAt === undefined && machine.enrolledMachineId ? [[machine.enrolledMachineId, machine]] : []));
            return [serverId, retainShallow(retained, index)];
        }));
        const machinesByEnrolledMachineIdByServerId = retainShallow(previous.machinesByEnrolledMachineIdByServerId, enrolled);
        return previousDisplay.current = { machinesByServerId, machinesByEnrolledMachineIdByServerId };
    }, [currentEntries, requestedIdsKey]);

    let loading = false;
    let firstAnswerPending = false;
    for (const serverId of ids) {
        const pending = getServerProfileById(serverId)?.serverIdentityId
            && ((!accountScopes.has(serverId) || accountScopes.get(serverId)?.resolution.kind === 'resolving')
                || (bindings.has(serverId) && (!currentEntries[serverId] || currentEntries[serverId]?.status === 'loading')));
        if (!pending) continue;
        loading = true;
        // Active membership admits the collection even while archive recovery is
        // pending. Refreshes keep that receipt; terminal failures settle the wait.
        if (currentEntries[serverId]?.asOf === undefined) firstAnswerPending = true;
    }
    return { entries: currentEntries, machinesByServerId, machinesByEnrolledMachineIdByServerId, refresh: refreshAll, bindings, accountScopes, loading, firstAnswerPending, executeAction };
}

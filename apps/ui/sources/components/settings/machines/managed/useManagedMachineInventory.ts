import * as React from 'react';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeStates, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { isArtifactOnlyHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { isManagedMachineResourceAbsent } from './managedMachineResource';

const execute = createFrontDoorActionExecute();
const EMPTY_ROWS: readonly ManagedMachineV1[] = [];
type InventoryExecute = ReturnType<typeof createDefaultActionExecutor>['execute'];

export type ManagedMachineInventoryEntry = Readonly<{
    accountId: string;
    homeId?: string;
    managedId?: string;
    includeArchived?: boolean;
    machines: readonly ManagedMachineV1[];
    status: 'loading' | 'ready' | 'error' | 'unsupported' | 'denied' | 'missing';
    errorCode?: string;
    asOf?: number;
    approval?: ActionApprovalRegistration;
}>;

type InventoryReader = ReturnType<typeof createInventoryReader>;
// Demand, not a row or a naming registry, owns the read. The last reader leaving
// or retiring its credential binding removes the projection and its Home observer.
type InventoryDemand = { readers: Map<string, InventoryReader>; observers: Set<() => void> };
const demandedInventories = new WeakMap<InventoryExecute, InventoryDemand>();

function inventoryDemand(executeAction: InventoryExecute): InventoryDemand {
    let demand = demandedInventories.get(executeAction);
    if (!demand) {
        demand = { readers: new Map(), observers: new Set() };
        demandedInventories.set(executeAction, demand);
    }
    return demand;
}

function inventoryKey(serverId: string, accountId: string | undefined, homeId: string | null | undefined, managedId: string | undefined, includeArchived: boolean): string {
    return JSON.stringify([serverId, accountId, homeId, managedId, includeArchived]);
}

function createInventoryReader(serverId: string, accountId: string, homeId: string, managedId: string | undefined,
    includeArchived: boolean, executeAction: InventoryExecute, remove: () => void, onPublished: () => void, retained?: ManagedMachineInventoryEntry) {
    const consumers = new Map<() => void, ServerCredentialAccountScopeBinding>();
    let entry: ManagedMachineInventoryEntry = { accountId, homeId, managedId, includeArchived,
        machines: retained?.machines ?? EMPTY_ROWS, ...(retained?.asOf !== undefined ? { asOf: retained.asOf } : {}), status: 'loading' };
    let controller: AbortController | null = null;
    let awaitingApproval = false;
    let disposed = false;
    const isCurrent = () => !disposed && getServerProfileById(serverId)?.serverIdentityId === homeId
        && [...consumers.values()].some(binding => binding.isCurrent());
    const publish = (next: ManagedMachineInventoryEntry) => {
        entry = next;
        for (const listener of consumers.keys()) listener();
        onPublished();
    };
    const refresh = () => {
        if (!isCurrent()) return;
        controller?.abort();
        const cancellation = new AbortController();
        controller = cancellation;
        awaitingApproval = false;
        // Revalidating the same live binding does not make a hydrated answer
        // non-current. Keep its authority and mutations stable until the new
        // read either replaces it or returns a terminal failure.
        if (entry.status !== 'ready') publish({ accountId, homeId, managedId, includeArchived, machines: entry.machines,
            ...(entry.asOf !== undefined ? { asOf: entry.asOf } : {}), status: 'loading' });
        void (async () => {
                try {
                    type ReadResult = Readonly<{ kind: 'succeeded'; machines: ManagedMachineV1[] }> | Readonly<{ kind: 'failed'; code: string }>;
                    const actionId = managedId ? 'machines.managed.get' : 'machines.managed.list';
                    const read = (input: { homeId: string; managedId?: string; archived?: boolean }) => awaitActionApprovalResult<ManagedMachineV1[], ReadResult>({
                        signal: cancellation.signal,
                        execute: async callbacks => {
                            const outcome = classifyHomeActionOutcome(await executeAction(actionId, input, { surface: 'ui', serverId,
                                    expectedAccountId: accountId, signal: cancellation.signal }));
                            if (!isCurrent() || cancellation.signal.aborted) return { kind: 'failed', code: 'aborted' };
                            if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                            if (outcome.kind === 'approval_pending') {
                                awaitingApproval = true;
                                const approval = createActionApprovalContinuation<ManagedMachineV1 | { machines: ManagedMachineV1[] }, typeof actionId>({
                                    artifactId: outcome.artifactId, actionId, scope: { serverId, accountId }, expectedInput: input,
                                    signal: cancellation.signal,
                                    onSucceeded: value => callbacks.onApprovalSucceeded('machines' in value ? value.machines : [value]),
                                    onFailed: callbacks.onApprovalFailed,
                                });
                                if (isCurrent() && !cancellation.signal.aborted) publish({ ...entry, status: 'loading', approval });
                                return { approvalPending: true };
                            }
                            const machines = managedId
                                ? [ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(outcome.result)]
                                : ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(outcome.result).machines;
                            return { kind: 'succeeded', machines };
                        },
                        succeeded: machines => ({ kind: 'succeeded', machines }), failed: code => ({ kind: 'failed', code }),
                        aborted: () => ({ kind: 'failed', code: 'aborted' }),
                    });
                    let result = await read(managedId ? { homeId, managedId } : { homeId });
                    if (cancellation.signal.aborted || !isCurrent()) return;
                    awaitingApproval = false;
                    if (!managedId && includeArchived && result.kind === 'succeeded') {
                        // Archive availability must not discard a successfully read active list. Keep
                        // previous recovery rows visibly stale until the second ordinary read settles.
                        const active = result.machines;
                        if (active.some(machine => machine.homeId !== homeId)) throw new Error('managed_response_invalid');
                        publish({ ...entry, asOf: Date.now(), machines:
                            [...new Map([...active, ...entry.machines.filter(machine => machine.archivedAt !== undefined)]
                                .map(machine => [machine.id, machine])).values()] });
                        const archived = await read({ homeId, archived: true });
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
                    if (machines.some(machine => machine.homeId !== homeId || (managedId && machine.id !== managedId))) throw new Error('managed_response_invalid');
                    publish({ accountId, homeId, managedId, includeArchived, status: 'ready', asOf: Date.now(),
                        machines: sameStrictJsonValue(entry.machines, machines) ? entry.machines : machines });
                } catch {
                    if (!isCurrent() || cancellation.signal.aborted) return;
                    const { approval: _approval, ...previous } = entry;
                    publish({ ...previous, status: 'error', errorCode: 'managed_request_failed' });
                } finally {
                    if (controller === cancellation) awaitingApproval = false;
                }
            })();
    };
    const unsubscribe = subscribeHomeAccountChange(event => {
        if (isArtifactOnlyHomeAccountChange(event) || awaitingApproval) return;
        if ((resolveServerProfileScopeIdForIdentifier(event.serverId) || event.serverId) === serverId) refresh();
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller?.abort();
        unsubscribe();
        remove();
    };
    return {
        get: () => entry,
        isCurrent,
        refresh,
        subscribe(binding: ServerCredentialAccountScopeBinding, listener: () => void) {
            consumers.set(listener, binding);
            const release = () => {
                consumers.delete(listener);
                if (![...consumers.values()].some(current => current.isCurrent())) dispose();
            };
            const retirement = binding.onRetire(release);
            listener();
            if (controller === null) refresh();
            return () => { retirement.dispose(); release(); };
        },
    };
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

/** A demanded projection of the canonical server inventory, with no persisted UI resource state. */
export function useManagedMachineInventory(serverIds: readonly string[], managedId?: string,
    executeAction: InventoryExecute = execute, includeArchived = false) {
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
        const keys = new Map(ids.map(serverId => [serverId, inventoryKey(
            serverId, bindings.get(serverId)?.accountId, getServerProfileById(serverId)?.serverIdentityId, managedId, includeArchived,
        )]));
        for (const [serverId, read] of reads.current) {
            if (read.binding === bindings.get(serverId) && read.binding.isCurrent() && read.reader.isCurrent()
                && read.key === keys.get(serverId) && read.executeAction === executeAction) continue;
            read.release(); reads.current.delete(serverId);
        }
        for (const serverId of ids) {
            const binding = bindings.get(serverId);
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            if (!binding?.isCurrent() || !homeId || reads.current.has(serverId)) continue;
            const demand = inventoryDemand(executeAction);
            const inventories = demand.readers;
            const notify = () => { if (!managedId) for (const observer of demand.observers) observer(); };
            const key = keys.get(serverId)!;
            let reader = inventories.get(key);
            if (!reader?.isCurrent()) {
                const current = entries[serverId];
                const retained = current?.accountId === binding.accountId && current.homeId === homeId && current.managedId === managedId
                    && (current.includeArchived ?? false) === includeArchived ? current : undefined;
                const ownedInventories = inventories;
                reader = createInventoryReader(serverId, binding.accountId, homeId, managedId, includeArchived, executeAction,
                    () => { if (ownedInventories.get(key) === reader) { ownedInventories.delete(key); notify(); } }, notify, retained);
                inventories.set(key, reader);
            }
            const ownedReader = reader;
            const release = reader.subscribe(binding, () => setEntries(previous => previous[serverId] === ownedReader.get()
                ? previous : { ...previous, [serverId]: ownedReader.get() }));
            reads.current.set(serverId, { binding, key, executeAction, reader, release });
        }
        // Entry updates are projections, not new demand. Only binding/target changes reacquire a reader.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bindings, ids, managedId, includeArchived, executeAction]);

    const currentEntries = React.useMemo(() => {
        const result: Record<string, ManagedMachineInventoryEntry> = {};
        for (const serverId of ids) {
            const binding = bindings.get(serverId);
            const entry = entries[serverId];
            if (binding?.isCurrent() && entry?.accountId === binding.accountId && entry.managedId === managedId
                && entry.homeId === getServerProfileById(serverId)?.serverIdentityId
                && (entry.includeArchived ?? false) === includeArchived) result[serverId] = entry;
        }
        return result;
    }, [bindings, entries, ids, managedId, includeArchived]);

    const machinesByServerId = React.useMemo(() => Object.fromEntries((JSON.parse(requestedIdsKey) as string[]).map(serverId => [serverId,
        currentEntries[resolveServerProfileScopeIdForIdentifier(serverId) || serverId]?.machines ?? EMPTY_ROWS,
    ])), [currentEntries, requestedIdsKey]);
    const machinesByEnrolledMachineIdByServerId = React.useMemo(() => Object.fromEntries<Readonly<Record<string, ManagedMachineV1>>>(
        Object.entries(machinesByServerId).map(([serverId, machines]) => [serverId, Object.fromEntries<ManagedMachineV1>(
            machines.flatMap(machine => machine.archivedAt === undefined && machine.enrolledMachineId ? [[machine.enrolledMachineId, machine]] : []),
        )]),
    ), [machinesByServerId]);

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
    return { entries: currentEntries, machinesByServerId, machinesByEnrolledMachineIdByServerId, refresh: refreshAll, bindings, accountScopes, loading, firstAnswerPending };
}

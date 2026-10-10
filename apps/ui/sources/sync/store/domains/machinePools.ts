import type { MachinePoolViewV1 } from '@happier-dev/protocol';
import type { StoreGet, StoreSet } from './_shared';

/**
 * The server's stable creation order (`createdAt`, then ID) is canonical for this version, so every
 * store path keeps incoming order, updates an existing row in place and appends a new one. Rows must
 * not move under the user as a side effect of a refresh or a rename.
 */
export type MachinePoolListStatus = 'idle' | 'loading' | 'signedOut' | 'error';
export type MachinePoolMutationScope = Readonly<{ sourceServerId: string; sourceAccountId: string }>;
export type MachinePoolReplaceScope = MachinePoolMutationScope & Readonly<{
    /** The exact list observed before this refresh started, for three-way stale-response merging. */
    baseline?: readonly MachinePoolViewV1[];
}>;
export type MachinePoolsDomain = {
    machinePoolListByServerId: Record<string, MachinePoolViewV1[] | null>;
    machinePoolListStatusByServerId: Record<string, MachinePoolListStatus>;
    /** Account identity that owns each in-memory Home projection. Never render rows across a change. */
    machinePoolAccountIdByServerId: Record<string, string>;
    beginMachinePoolAccountScope: (serverId: string, accountId: string) => void;
    replaceMachinePools: (pools: readonly MachinePoolViewV1[], scope: MachinePoolReplaceScope) => void;
    patchMachinePool: (pool: MachinePoolViewV1, scope: MachinePoolMutationScope) => void;
    removeMachinePool: (poolId: string, scope: MachinePoolMutationScope) => void;
    setMachinePoolListStatus: (serverId: string, status: MachinePoolListStatus) => void;
    clearMachinePoolsForServer: (serverId: string) => void;
};
const normalizeServerId = (value: string) => value.trim();
const normalizeAccountId = (value: string) => value.trim();
const samePoolView = (a: MachinePoolViewV1, b: MachinePoolViewV1) => (
    a.pool.id === b.pool.id
    && a.pool.revision === b.pool.revision
    && a.pool.members.length === b.pool.members.length
    && a.pool.members.every((member, index) => {
        const next = b.pool.members[index];
        return next !== undefined
            && member.machineId === next.machineId
            && member.priorityTier === next.priorityTier
            && member.enabled === next.enabled
            && member.state === next.state;
    })
    && a.availability.state === b.availability.state
    && (a.availability.state !== 'known' || (
        b.availability.state === 'known'
        && a.availability.connectedCount === b.availability.connectedCount
        && a.availability.enabledCount === b.availability.enabledCount
    ))
);

export function createMachinePoolsDomain<S extends MachinePoolsDomain>({ set }: { set: StoreSet<S>; get: StoreGet<S> }): MachinePoolsDomain {
    return {
        machinePoolListByServerId: {}, machinePoolListStatusByServerId: {}, machinePoolAccountIdByServerId: {},
        beginMachinePoolAccountScope: (serverIdRaw, accountIdRaw) => set((state) => {
            const serverId = normalizeServerId(serverIdRaw);
            const accountId = normalizeAccountId(accountIdRaw);
            if (!serverId || !accountId) return state;
            const currentAccountId = state.machinePoolAccountIdByServerId[serverId];
            if (currentAccountId === accountId) return state;
            const nextAccounts = { ...state.machinePoolAccountIdByServerId, [serverId]: accountId };
            const hasUnscopedProjection = serverId in state.machinePoolListByServerId
                || serverId in state.machinePoolListStatusByServerId;
            if (!currentAccountId && !hasUnscopedProjection) {
                return { machinePoolAccountIdByServerId: nextAccounts } as Partial<S>;
            }
            const nextPools = { ...state.machinePoolListByServerId };
            const nextStatuses = { ...state.machinePoolListStatusByServerId };
            delete nextPools[serverId];
            delete nextStatuses[serverId];
            return {
                machinePoolListByServerId: nextPools,
                machinePoolListStatusByServerId: nextStatuses,
                machinePoolAccountIdByServerId: nextAccounts,
            } as Partial<S>;
        }),
        replaceMachinePools: (incoming, scope) => set((state) => {
            const serverId = normalizeServerId(scope.sourceServerId);
            const accountId = normalizeAccountId(scope.sourceAccountId);
            if (!serverId || !accountId || state.machinePoolAccountIdByServerId[serverId] !== accountId) return state;
            const current = state.machinePoolListByServerId[serverId];
            let next = incoming.slice();
            if (scope.baseline && current) {
                const baselineById = new Map(scope.baseline.map((item) => [item.pool.id, item]));
                const currentById = new Map(current.map((item) => [item.pool.id, item]));
                const incomingIds = new Set(incoming.map((item) => item.pool.id));
                next = incoming.flatMap((item) => {
                    const baseline = baselineById.get(item.pool.id);
                    const local = currentById.get(item.pool.id);
                    if (baseline && !local) return [];
                    if (baseline && local && local.pool.revision > baseline.pool.revision && item.pool.revision < local.pool.revision) return [local];
                    return [item];
                });
                for (const local of current) {
                    if (incomingIds.has(local.pool.id)) continue;
                    const baseline = baselineById.get(local.pool.id);
                    if (!baseline || local.pool.revision > baseline.pool.revision) next.push(local);
                }
            }
            if (current) {
                const currentById = new Map(current.map((item) => [item.pool.id, item]));
                next = next.map((item) => {
                    const previous = currentById.get(item.pool.id);
                    return previous && samePoolView(previous, item) ? previous : item;
                });
            }
            const stable = Array.isArray(current) && current.length === next.length && current.every((item, index) => item === next[index]);
            const machinePoolListByServerId = stable
                ? state.machinePoolListByServerId
                : { ...state.machinePoolListByServerId, [serverId]: next };
            const machinePoolListStatusByServerId = state.machinePoolListStatusByServerId[serverId] === 'idle'
                ? state.machinePoolListStatusByServerId
                : { ...state.machinePoolListStatusByServerId, [serverId]: 'idle' as const };
            if (machinePoolListByServerId === state.machinePoolListByServerId
                && machinePoolListStatusByServerId === state.machinePoolListStatusByServerId) return state;
            return { machinePoolListByServerId, machinePoolListStatusByServerId } as Partial<S>;
        }),
        patchMachinePool: (incoming, scope) => set((state) => {
            const serverId = normalizeServerId(scope.sourceServerId);
            const accountId = normalizeAccountId(scope.sourceAccountId);
            if (!serverId || !accountId || state.machinePoolAccountIdByServerId[serverId] !== accountId) return state;
            const current = state.machinePoolListByServerId[serverId] ?? []; const index = current.findIndex((item) => item.pool.id === incoming.pool.id);
            if (index >= 0 && current[index]!.pool.revision > incoming.pool.revision) return state;
            if (index >= 0 && samePoolView(current[index]!, incoming)) return state;
            const next = current.slice(); if (index >= 0) next[index] = incoming; else next.push(incoming);
            return { machinePoolListByServerId: { ...state.machinePoolListByServerId, [serverId]: next } } as Partial<S>;
        }),
        removeMachinePool: (poolId, scope) => set((state) => {
            const serverId = normalizeServerId(scope.sourceServerId);
            const accountId = normalizeAccountId(scope.sourceAccountId);
            if (!serverId || !accountId || state.machinePoolAccountIdByServerId[serverId] !== accountId) return state;
            const current = state.machinePoolListByServerId[serverId];
            if (!serverId || !current?.some((item) => item.pool.id === poolId)) return state;
            return { machinePoolListByServerId: { ...state.machinePoolListByServerId, [serverId]: current.filter((item) => item.pool.id !== poolId) } } as Partial<S>;
        }),
        setMachinePoolListStatus: (serverIdRaw, status) => set((state) => {
            const serverId = normalizeServerId(serverIdRaw); if (!serverId || state.machinePoolListStatusByServerId[serverId] === status) return state;
            return { machinePoolListStatusByServerId: { ...state.machinePoolListStatusByServerId, [serverId]: status } } as Partial<S>;
        }),
        clearMachinePoolsForServer: (serverIdRaw) => set((state) => {
            const serverId = normalizeServerId(serverIdRaw);
            if (!serverId || (!(serverId in state.machinePoolListByServerId) && !(serverId in state.machinePoolListStatusByServerId) && !(serverId in state.machinePoolAccountIdByServerId))) return state;
            const nextPools = { ...state.machinePoolListByServerId };
            const nextStatuses = { ...state.machinePoolListStatusByServerId };
            const nextAccounts = { ...state.machinePoolAccountIdByServerId };
            delete nextPools[serverId];
            delete nextStatuses[serverId];
            delete nextAccounts[serverId];
            return { machinePoolListByServerId: nextPools, machinePoolListStatusByServerId: nextStatuses, machinePoolAccountIdByServerId: nextAccounts } as Partial<S>;
        }),
    };
}

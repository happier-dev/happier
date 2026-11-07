import * as React from 'react';
import { getDemoMachineRead } from '@/demoMode/runtime/demoMachineReadProjection';
import type { CliUpdateFacts } from '@happier-dev/protocol/machines/cliUpdateFacts';

import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachines, resolveServerScopedMachineInventory, resolveServerScopedMachineInventoryKeys, selectMachineInventoryRowsById } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, getServerProfilesGeneration, subscribeServerProfiles, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { isMachineVisibleForLaunchSelection, isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { isMachineSelectableForFleet, resolveFleetMachineAvailability } from '@/sync/domains/machines/administration/fleetUnion';
import {
    isMachineReachable,
    resolveMachineReachability,
    subscribeMachineRequestReachability,
} from '@/sync/domains/machines/reachability/machineReachability';
import { getMachineDisplayName, isMachineOnline, readMachineStatusNextRefreshAtMs, type MachinePresenceCounts } from '@/utils/sessions/machineUtils';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import type { SessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';
import { readMachineActivity, subscribeMachineActivity } from '@/sync/domains/machines/machineActivity';

/**
 * What a pane header says about the machine a tab runs on ("~/happier on MacBook Pro", "MacBook Pro is
 * offline"): its name, its home folder for `~` paths, and whether it is reachable. Primitives only, so
 * a heartbeat that does not flip presence re-renders nothing.
 *
 * `reachability` is the existing session reachability vocabulary: `unknown` when the machine record
 * is not visible from here (a shared Session), which callers must not present as offline.
 */
export type MachinePresenceSummary = Readonly<{
    /** Selected recipient-safe lifecycle and heartbeat facts; UI presentation never reclassifies native power. */
    nativeState?: import('@happier-dev/protocol/machines/managed/managedMachineV1').ManagedMachineInputRuntimeV1['state'];
    presenceOnline?: boolean;
    name: string | null;
    /** The name as a sentence uses it ("Reading it from {machine}"): "this machine" while its details load or are locked. */
    sentenceName?: string | null;
    homeDir: string | null;
    reachability: SessionMachineReachability;
    /** Distinguishes a retained unobserved row from a shared Session's invisible Machine. */
    machineIsKnown?: boolean;
    /** The offline machine's last heartbeat ("last seen 09:12"); null for live or unknown presence. */
    lastSeenAt?: number | null;
}>;

export function useMachinePresenceSummary(
    serverId: string | null | undefined,
    machineId: string | null | undefined,
    suppliedLifetime?: ServerAccountScopeLifetime | null,
    /** A caller reading only some facts: an equal summary keeps its identity and wakes nothing. */
    areEqual?: (left: MachinePresenceSummary, right: MachinePresenceSummary) => boolean,
): MachinePresenceSummary {
    const areSummariesEqual = React.useMemo(() => areEqual
        ? (left: readonly MachinePresenceSummary[], right: readonly MachinePresenceSummary[]) => areEqual(left[0]!, right[0]!)
        : undefined, [areEqual]);
    return useMachinePresenceSummaries(serverId, [machineId ?? ''], suppliedLifetime, areSummariesEqual)[0]!;
}

/** All-machines daemon reads share the same pushed presence lifecycle. */
export function useMachinePresenceSummaries(
    serverId: string | null | undefined,
    machineIds: readonly string[],
    suppliedLifetime?: ServerAccountScopeLifetime | null,
    areEqual?: (left: readonly MachinePresenceSummary[], right: readonly MachinePresenceSummary[]) => boolean,
): readonly MachinePresenceSummary[] {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const scope = useMachinePresenceScope(targetServerId, suppliedLifetime);
    const cached = React.useRef<readonly MachinePresenceSummary[]>([]);
    const idsKey = JSON.stringify(machineIds);
    const ids = React.useMemo(() => (JSON.parse(idsKey) as string[]).map(id => id.trim()), [idsKey]);
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        const state = store.getState();
        const activeServerId = getActiveServerSnapshot().serverId;
        const serverId = targetServerId || activeServerId;
        // Resolve Home inventory once, not once for each requested Machine.
        const machines = serverId ? resolveServerScopedMachines({
            serverId, activeServerId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId) : null;
        return serverId ? selectMachineInventoryRowsById(machines, ids)
            : ids.map(id => id ? state.machines[id] ?? null : null);
    }, [store, targetServerId, ids]);
    const readSnapshot = React.useCallback((nowMs: number): readonly MachinePresenceSummary[] => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const next = readMachines(resolveScopeId).map((machine, index): MachinePresenceSummary => {
            const name = machine ? getMachineDisplayName(machine).trim() || null : null;
            const sentenceName = machine ? getMachineSentenceName(machine, name ?? undefined) : null;
            const homeDir = machine?.metadata?.homeDir?.trim() || null;
            const reachability = machine && getDemoMachineRead({ serverId: targetServerId, machineId: machine.id }) ? 'reachable'
                : machine ? resolveMachineReachability(scope, machine, nowMs, resolveScopeId) : 'unknown';
            const machineIsKnown = Boolean(machine);
            const activeAt = machine ? readMachineActivity(machine).activeAt : null;
            const nativeState = machine?.managedInputRuntime?.state ?? null;
            const presenceOnline = Boolean(machine && isMachineOnline(machine, nowMs));
            const lastSeenAt = reachability === 'unreachable' && machine && !presenceOnline
                && typeof activeAt === 'number' && activeAt > 0
                ? activeAt : null;
            const previous = cached.current[index];
            return previous && previous.name === name && previous.sentenceName === sentenceName && previous.homeDir === homeDir
                && previous.reachability === reachability && previous.lastSeenAt === lastSeenAt && previous.machineIsKnown === machineIsKnown
                && previous.nativeState === nativeState && previous.presenceOnline === presenceOnline
                ? previous : { name, sentenceName, homeDir, reachability, lastSeenAt, machineIsKnown, nativeState, presenceOnline };
        });
        if (next.length !== cached.current.length || next.some((value, index) => value !== cached.current[index])) cached.current = next;
        return cached.current;
    }, [readMachines, scope, ids, targetServerId]);
    const targets = React.useMemo(() => [{ serverId: targetServerId, machineIds: ids }], [targetServerId, ids]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, areEqual);
}

export type MachineCliUpdateFact = Readonly<{
    id: string;
    metadataPresent: boolean;
    platform: string | null;
    happyCliVersion: string | null;
    cliUpdate: CliUpdateFacts | null;
    online: boolean | null;
}>;

export type MachineCliUpdateFactsSnapshot = Readonly<{
    machineIds: readonly string[];
    facts: readonly MachineCliUpdateFact[];
}>;

/** Only the machine-published CLI facts, independent of unrelated metadata or presentation. */
function projectCliUpdateFacts(facts: CliUpdateFacts | null, previous: CliUpdateFacts | null): CliUpdateFacts | null {
    if (!facts) return null;
    const lastUpdate = facts.lastUpdate;
    const previousLastUpdate = previous?.lastUpdate;
    const sameLastUpdate = lastUpdate === null ? previousLastUpdate === null
        : previousLastUpdate != null && lastUpdate.outcome === previousLastUpdate.outcome
            && lastUpdate.targetVersion === previousLastUpdate.targetVersion
            && lastUpdate.at === previousLastUpdate.at && lastUpdate.message === previousLastUpdate.message;
    if (previous && facts.currentVersion === previous.currentVersion && facts.latestVersion === previous.latestVersion
        && facts.channel === previous.channel && facts.installSource === previous.installSource
        && facts.updateCommand === previous.updateCommand && facts.canUpdateRemotely === previous.canUpdateRemotely
        && sameLastUpdate) return previous;
    return {
        currentVersion: facts.currentVersion,
        latestVersion: facts.latestVersion,
        channel: facts.channel,
        installSource: facts.installSource,
        updateCommand: facts.updateCommand,
        canUpdateRemotely: facts.canUpdateRemotely,
        lastUpdate: lastUpdate?.outcome === 'failed' ? {
            outcome: lastUpdate.outcome, targetVersion: lastUpdate.targetVersion,
            at: lastUpdate.at, message: lastUpdate.message,
        } : lastUpdate ? {
            outcome: lastUpdate.outcome, targetVersion: lastUpdate.targetVersion,
            at: lastUpdate.at, message: lastUpdate.message,
        } : null,
    };
}

/** CLI consumers observe their facts, not Machine names, heartbeat timestamps or whole rows. */
export function useMachineCliUpdateFacts(
    serverId: string | null | undefined,
    suppliedLifetime?: ServerAccountScopeLifetime | null,
): MachineCliUpdateFactsSnapshot {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const scope = useMachinePresenceScope(targetServerId, suppliedLifetime);
    const cached = React.useRef<MachineCliUpdateFactsSnapshot>({ machineIds: [], facts: [] });
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        const state = store.getState();
        const machines = targetServerId ? resolveServerScopedMachines({
            serverId: targetServerId,
            activeServerId: getActiveServerSnapshot().serverId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId) ?? [] : Object.values(state.machines);
        return machines.filter(isMachineVisibleForSelection);
    }, [store, targetServerId]);
    const readSnapshot = React.useCallback((nowMs: number): MachineCliUpdateFactsSnapshot => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const machines = readMachines(resolveScopeId).sort((left, right) => left.id.localeCompare(right.id));
        const previous = cached.current;
        const previousById = new Map(previous.facts.map(fact => [fact.id, fact]));
        const facts = machines.map((machine): MachineCliUpdateFact => {
            const before = previousById.get(machine.id);
            const metadataPresent = Boolean(machine.metadata);
            const platform = machine.metadata?.platform ?? null;
            const happyCliVersion = machine.metadata?.happyCliVersion || null;
            const cliUpdate = projectCliUpdateFacts(machine.metadata?.cliUpdate ?? null, before?.cliUpdate ?? null);
            const availability = resolveFleetMachineAvailability(scope, machine, nowMs, resolveScopeId);
            const online = availability === 'unknown' ? null : availability === 'online';
            return before && before.metadataPresent === metadataPresent && before.platform === platform
                && before.happyCliVersion === happyCliVersion && before.cliUpdate === cliUpdate && before.online === online
                ? before : { id: machine.id, metadataPresent, platform, happyCliVersion, cliUpdate, online };
        });
        const idsChanged = facts.length !== previous.machineIds.length
            || facts.some((fact, index) => fact.id !== previous.machineIds[index]);
        if (idsChanged || facts.some((fact, index) => fact !== previous.facts[index])) {
            cached.current = {
                machineIds: idsChanged ? facts.map(fact => fact.id) : previous.machineIds,
                facts,
            };
        }
        return cached.current;
    }, [readMachines, scope]);
    const targets = React.useMemo(() => [{ serverId: targetServerId }], [targetServerId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
}

export type MachinePresenceMembership = Readonly<{
    onlineMachineIds: readonly string[];
    selectableMachineIds: readonly string[];
    counts: MachinePresenceCounts;
}>;

function useMachinePresenceScope(
    targetServerId: string | null,
    suppliedLifetime?: ServerAccountScopeLifetime | null,
) {
    const { binding } = useServerCredentialAccountScopeBinding(suppliedLifetime === undefined ? targetServerId : null);
    const subscribeSuppliedLifetime = React.useCallback((notify: () => void) => {
        const retirement = suppliedLifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [suppliedLifetime]);
    const readSuppliedCurrentness = React.useCallback(() => suppliedLifetime?.isCurrent() === true, [suppliedLifetime]);
    const suppliedCurrent = React.useSyncExternalStore(subscribeSuppliedLifetime, readSuppliedCurrentness, readSuppliedCurrentness);
    // A composition owner can supply its already admitted exact Account. An
    // explicit absent, retired or different-Home owner never borrows another one.
    return suppliedLifetime === undefined
        ? binding?.isCurrent() ? binding.scope : null
        : suppliedCurrent && suppliedLifetime
            && areServerProfileIdentifiersEquivalent(suppliedLifetime.scope.serverId, targetServerId)
            ? suppliedLifetime.scope : null;
}

/** App-wide consumers need membership, not heartbeat timestamps or machine presentation. */
export function useMachinePresenceMembership(
    serverId: string | null,
    suppliedLifetime?: ServerAccountScopeLifetime | null,
): MachinePresenceMembership {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const scope = useMachinePresenceScope(targetServerId, suppliedLifetime);
    const cached = React.useRef<MachinePresenceMembership>({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 0, unknown: 0 } });
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        const state = store.getState();
        const activeMachines = Object.values(state.machines);
        const machines = targetServerId ? resolveServerScopedMachines({
            serverId: targetServerId,
            activeServerId: getActiveServerSnapshot().serverId,
            activeMachines,
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId) ?? [] : activeMachines;
        return machines.filter(isMachineVisibleForSelection);
    }, [store, targetServerId]);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const machines = readMachines(resolveScopeId);
        const onlineMachineIds = machines.filter(machine => isMachineReachable(scope, machine, nowMs, resolveScopeId))
            .map(machine => machine.id).sort((left, right) => left.localeCompare(right));
        const selectableMachineIds = machines.filter(machine => isMachineSelectableForFleet(scope, machine, nowMs, resolveScopeId))
            .map(machine => machine.id).sort((left, right) => left.localeCompare(right));
        const counts = { online: 0, offline: 0, unknown: 0 };
        for (const machine of machines) {
            if (!isMachineVisibleForLaunchSelection(machine)) continue;
            const verdict = resolveMachineReachability(scope, machine, nowMs, resolveScopeId);
            if (verdict === 'reachable') counts.online += 1;
            else if (verdict === 'unreachable') counts.offline += 1;
            else counts.unknown += 1;
        }
        const previous = cached.current;
        const onlineChanged = onlineMachineIds.length !== previous.onlineMachineIds.length
            || onlineMachineIds.some((id, index) => id !== previous.onlineMachineIds[index]);
        const selectableChanged = selectableMachineIds.length !== previous.selectableMachineIds.length
            || selectableMachineIds.some((id, index) => id !== previous.selectableMachineIds[index]);
        const countsChanged = counts.online !== previous.counts.online || counts.offline !== previous.counts.offline || counts.unknown !== previous.counts.unknown;
        if (onlineChanged || selectableChanged || countsChanged) {
            cached.current = {
                onlineMachineIds: onlineChanged ? onlineMachineIds : previous.onlineMachineIds,
                selectableMachineIds: selectableChanged ? selectableMachineIds : previous.selectableMachineIds,
                counts: countsChanged ? counts : previous.counts,
            };
        }
        return cached.current;
    }, [readMachines, scope]);
    const targets = React.useMemo(() => [{ serverId: targetServerId }], [targetServerId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
}

export type MachinePresenceTarget = Readonly<{
    serverId: string | null | undefined;
    /** Omit for the Home's fleet; an empty list observes no Machine rows. */
    machineIds?: readonly string[];
}>;

type PresenceState = ReturnType<ReturnType<typeof getStorage>['getState']>;

/** Reuse the inventory owner's Home equivalence, settlement and active fallback rules. */
function createPresenceInputReader(targets: readonly MachinePresenceTarget[], activeServerId: string): (state: PresenceState) => readonly unknown[] {
    type Machine = PresenceState['machines'][string];
    const selections: Array<Readonly<{ inventory: readonly Machine[] | null; rows: readonly (Machine | null)[] }> | undefined> = [];
    let activeMap: PresenceState['machines'] | undefined;
    let activeRows: Machine[] = [];
    let rawInputs: readonly unknown[] | undefined;
    let inputs: readonly unknown[] = [];
    return state => {
        const nextRawInputs = [state.machines, state.machineListByServerId, state.machineListStatusByServerId,
            state.machinePresenceByServerId, state.machinePresenceById];
        if (rawInputs && samePresenceInputs(rawInputs, nextRawInputs)) return inputs;
        rawInputs = nextRawInputs;
        const resolveScopeId = captureServerProfileScopeResolver();
        const nextInputs: unknown[] = [];
        for (const [targetIndex, target] of targets.entries()) {
            if (target.machineIds?.length === 0) continue;
            const serverId = target.serverId?.trim() || activeServerId;
            const keys = resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: state.machineListByServerId }, resolveScopeId);
            let usedActiveRows = false;
            const inventory = resolveServerScopedMachineInventory({ serverId, activeServerId,
                get activeMachines() {
                    usedActiveRows = true;
                    if (activeMap !== state.machines) {
                        activeMap = state.machines;
                        activeRows = Object.values(state.machines);
                    }
                    return activeRows;
                },
                machineListByServerId: state.machineListByServerId,
                machineListStatusByServerId: state.machineListStatusByServerId,
            }, resolveScopeId);
            const presenceKey = keys.find(key => state.machinePresenceByServerId[key] !== undefined);
            const presence = presenceKey ? state.machinePresenceByServerId[presenceKey]
                : areServerProfileIdentifiersEquivalent(serverId, activeServerId, resolveScopeId) ? state.machinePresenceById : undefined;
            nextInputs.push(inventory.status);
            if (target.machineIds) {
                let selected = selections[targetIndex];
                if (!selected || selected.inventory !== inventory.machines) {
                    selected = { inventory: inventory.machines, rows: selectMachineInventoryRowsById(inventory.machines, target.machineIds) };
                    selections[targetIndex] = selected;
                }
                for (const [index, id] of target.machineIds.entries()) nextInputs.push(selected.rows[index], presence?.[id]);
            } else {
                nextInputs.push(usedActiveRows && inventory.machines === activeRows ? state.machines : inventory.machines, presence);
            }
        }
        inputs = nextInputs;
        return inputs;
    };
}

function samePresenceInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** React reads one immutable projection until one of its subscribed sources moves. */
export function useMachinePresenceSnapshot<T>(
    readMachines: () => readonly (Parameters<typeof isMachineOnline>[0] | null)[],
    readSnapshot: (nowMs: number) => T,
    targets: readonly MachinePresenceTarget[],
    areEqual?: (left: T, right: T) => boolean,
    /** Select demanded source facts before running a more expensive projection. */
    readDemandedInputs?: (nowMs: number) => readonly unknown[],
): T {
    const store = getStorage();
    const activeServerId = useActiveServerSnapshot().serverId;
    const profilesGeneration = React.useSyncExternalStore(subscribeServerProfiles, getServerProfilesGeneration, getServerProfilesGeneration);
    // A renewed source (new target, reader or Home) that yields equal content keeps the published value.
    const published = React.useRef<Readonly<{ value: T }> | null>(null);
    const source = React.useMemo(() => {
        const observedTargets = targets.map(target => ({ ...target,
            machineIds: target.machineIds?.map(id => id.trim()).filter(Boolean),
        }));
        // This is the incumbent snapshot's finite, mounted-owner input state, not
        // an inventory index: an unchanged Home never walks its selected rows again.
        const readInputs = createPresenceInputReader(observedTargets, activeServerId);
        let revision = 0;
        let cached: Readonly<{ inputs: readonly unknown[]; revision: number; value: T; demandedInputs?: readonly unknown[] }> | undefined;
        const getSnapshot = () => {
            const inputs = readInputs(store.getState());
            if (cached && cached.revision === revision && samePresenceInputs(cached.inputs, inputs)) return cached.value;
            // Sample wall time only at an observed input/request transition.
            const nowMs = Date.now();
            const demandedInputs = readDemandedInputs?.(nowMs);
            const nextValue = cached && demandedInputs && cached.demandedInputs && samePresenceInputs(cached.demandedInputs, demandedInputs)
                ? cached.value : readSnapshot(nowMs);
            const previous = cached ?? published.current;
            const value = previous && areEqual?.(previous.value, nextValue) ? previous.value : nextValue;
            cached = { inputs, revision, value, demandedInputs };
            published.current = { value };
            return value;
        };
        const subscribe = (listener: () => void) => {
            const token = {};
            let inputs = readInputs(store.getState());
            let stopActivity = () => {};
            const refresh = (rebindActivity = false) => {
                const machines = readMachines();
                if (rebindActivity) observeActivity(machines);
                let nextDeadline: number | null = null;
                const nowMs = Date.now();
                for (const machine of machines) {
                    const deadline = machine ? readMachineStatusNextRefreshAtMs(machine, nowMs) : null;
                    if (deadline !== null) nextDeadline = nextDeadline === null ? deadline : Math.min(nextDeadline, deadline);
                }
                if (nextDeadline === null) sessionListRuntimeClock.clearWake(token);
                else sessionListRuntimeClock.requestWake(token, nextDeadline);
                listener();
            };
            const onActivity = () => {
                revision += 1;
                refresh();
            };
            const observeActivity = (machines: ReturnType<typeof readMachines>) => {
                stopActivity();
                const stops = machines.flatMap(machine => machine ? [subscribeMachineActivity(machine, onActivity)] : []);
                stopActivity = () => { for (const stop of stops) stop(); };
            };
            const stopStore = store.subscribe(state => {
                const next = readInputs(state);
                if (samePresenceInputs(inputs, next)) return;
                inputs = next;
                refresh(true);
            }, { machines: true, machineListByServerId: true, machineListStatusByServerId: true,
                machinePresenceByServerId: true, machinePresenceById: true });
            const stopRequests = subscribeMachineRequestReachability(change => {
                if (change && !observedTargets.some(target => target.machineIds?.length !== 0
                    && areServerProfileIdentifiersEquivalent(target.serverId?.trim() || activeServerId, change.scope.serverId)
                    && (!target.machineIds || !change.machineIds || target.machineIds.some(id => change.machineIds!.includes(id))))) return;
                revision += 1;
                refresh();
            });
            const stopClock = sessionListRuntimeClock.subscribeWake(token, () => {
                revision += 1;
                refresh();
            });
            // A request or activity may move after React's render read but before
            // subscription (or while unsubscribed). Re-sample once after attaching.
            revision += 1;
            refresh(true);
            return () => { stopStore(); stopRequests(); stopActivity(); stopClock(); };
        };
        return { getSnapshot, subscribe };
    }, [store, readSnapshot, readMachines, targets, areEqual, readDemandedInputs, activeServerId, profilesGeneration]);
    return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

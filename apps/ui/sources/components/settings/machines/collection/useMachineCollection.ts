import * as React from 'react';

import { useMachinePresenceSnapshot, type MachinePresenceTarget } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { partitionMachineFleetPresence, resolveMachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { describeMachineRuntimePresence } from '@/utils/sessions/machinePresenceLine';
import { reconcileStableRows } from '@/hooks/session/reconcileStableRows';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { selectMachineFleet, selectVisibleMachineInventory } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolveMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors, type ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import { readManagedInstallationPrompt } from '../managed/managedCreationPresentation';
import { useManagedMachineInventory } from '../managed/useManagedMachineInventory';

import { buildMachineCollection, reconcileMachineCollection, managedMachineConsentKey, machineCollectionRowKey, selectMachineCollectionMembership, type MachineCollection, type MachineCollectionRow } from './machineCollectionModel';

/** Structural inventory changes rebuild the collection; presence belongs to its visible leaves. */
export function useMachineCollection(input: Omit<Parameters<typeof buildMachineCollection>[0], 'nowMs' | 'creationOperations' | 'awaitingConsent'>): MachineCollection {
    const language = usePreferredLanguage();
    const { groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId } = input;
    // Every collection reads the same qualified lifecycle selection as managed detail, including joined setup
    // attachments and terminal diagnostics. Stable owner projections keep unrelated operations out of the list.
    const readOperations = React.useMemo(() => {
        let previous: Readonly<Record<string, ActionOperationProjection | null>> | undefined;
        return () => {
            const state = actionOperationStore.getSnapshot();
            const next: Record<string, ActionOperationProjection | null> = {};
            for (const group of groups) for (const machine of managedByServerId?.[group.serverId] ?? []) {
                next[managedMachineConsentKey(group.serverId, machine.id)] = actionOperationSelectors.selectForManagedMachine(state, {
                    serverId: group.serverId, accountId: group.accountScope?.accountId ?? null,
                    machineId: machine.controller?.machineId ?? '', managedId: machine.id, managedMachine: machine,
                    homeId: machine.homeId, enrolledMachineId: machine.enrolledMachineId,
                });
            }
            previous = retainShallow(previous, next);
            return previous;
        };
    }, [groups, managedByServerId]);
    const operations = React.useSyncExternalStore(actionOperationStore.subscribe, readOperations, readOperations);
    const { creationOperations, awaitingConsent } = React.useMemo(() => {
        const creationOperations = new Map<string, ActionOperationProjection>();
        const awaitingConsent = new Set<string>();
        for (const [key, operation] of Object.entries(operations)) {
            if (!operation) continue;
            creationOperations.set(key, operation);
            if (readManagedInstallationPrompt(operation)) awaitingConsent.add(key);
        }
        return { creationOperations, awaitingConsent };
    }, [operations]);
    const published = React.useRef<MachineCollection | null>(null);
    // The collection is rebuilt from its inputs; rows are reconciled by key against the one published last,
    // so every consumer (index, rail, popover) sees one new row for one changed Machine.
    return React.useMemo(() => {
        published.current = reconcileMachineCollection(published.current, buildMachineCollection({
            groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent, creationOperations, nowMs: Date.now(),
        }));
        return published.current;
    }, [language, groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent, creationOperations]);
}

/** Row badges and aggregate badges share the same canonical presence projection. */
export function useMachineCollectionPresenceRows<Row extends MachineCollectionRow>(rows: readonly Row[]): readonly Row[] {
    const readMachines = React.useCallback(() => rows.flatMap(row => row.presenceSource ? [row.presenceSource.machine] : []), [rows]);
    const previous = React.useRef<readonly Row[]>(rows);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const next = rows.map(row => {
            const source = row.presenceSource;
            if (!source) return row;
            const connection = resolveMachineFleetPresence(source.scope, source.machine, nowMs);
            const fleetPresence = row.fleetPresence?.member === connection.member && row.fleetPresence.online === connection.online
                && row.fleetPresence.reachability === connection.reachability ? row.fleetPresence : connection;
            const presence = describeMachineRuntimePresence(source.machine, nowMs, source.managedPresence, source.scope, fleetPresence.reachability);
            const presenceWord = presence.showStatus ? presence.label : undefined;
            return row.fleetPresence === fleetPresence && row.online === presence.online && row.status === presence.status && row.presence === presence.label && row.presenceWord === presenceWord
                ? row : { ...row, fleetPresence, online: presence.online, status: presence.status, presence: presence.label, presenceWord };
        });
        previous.current = reconcileStableRows(previous.current, next, machineCollectionRowKey);
        return previous.current;
    }, [rows]);
    const targets = React.useMemo(() => rows.flatMap(row => row.presenceSource?.machine.id
        ? [{ serverId: row.serverId, machineIds: [row.presenceSource.machine.id] }] : []), [rows]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
}

export function useMachineCollectionRowPresence(row: MachineCollectionRow): MachineCollectionRow {
    const rows = React.useMemo(() => [row], [row]);
    return useMachineCollectionPresenceRows(rows)[0]!;
}

type CollectionPresenceGroup = Pick<ActiveSelectionMachineGroup, 'serverId' | 'accountScope' | 'machines'>;
type CollectionPresenceSource = Omit<CollectionPresenceGroup, 'machines'> & {
    readMachines: () => CollectionPresenceGroup['machines'];
    machineIds?: readonly string[];
};

function useMachineCollectionPresence(
    sources: readonly CollectionPresenceSource[],
    managedByServerId: Parameters<typeof buildMachineCollection>[0]['managedByServerId'],
    managedFirstAnswerPending: boolean,
) {
    const readMembership = React.useMemo(() => {
        const readers = (managedFirstAnswerPending ? [] : sources).map(source => {
            let previous: { machines: CollectionPresenceGroup['machines']; enrolled: CollectionPresenceGroup['machines'];
                accountScope: CollectionPresenceSource['accountScope']; count: number } | undefined;
            return () => {
                const machines = source.readMachines();
                if (previous?.machines === machines) return previous;
                const selected = selectMachineCollectionMembership(machines, managedByServerId?.[source.serverId]);
                previous = { machines, enrolled: selectMachineFleet(selected.currentEnrolled),
                    accountScope: source.accountScope, count: selected.count };
                return previous;
            };
        });
        return () => readers.map(read => read());
    }, [sources, managedByServerId, managedFirstAnswerPending]);
    const readMachines = React.useCallback(() => readMembership().flatMap(home => home.enrolled), [readMembership]);
    const readSnapshot = React.useCallback((nowMs: number) => {
        let total = 0;
        let online = 0;
        let offline = 0;
        for (const { accountScope, enrolled, count } of readMembership()) {
            const { counts } = partitionMachineFleetPresence(enrolled, machine => resolveMachineFleetPresence(accountScope, machine, nowMs));
            total += count;
            online += counts.online;
            offline += counts.offline;
        }
        // Retained history and standalone creations have no current connection to classify.
        return { online, offline, unknown: total - online - offline };
    }, [readMembership]);
    const targets = React.useMemo((): readonly MachinePresenceTarget[] => managedFirstAnswerPending ? [] : sources.map(source => ({
        serverId: source.serverId, machineIds: source.machineIds,
    })), [sources, managedFirstAnswerPending]);
    const areEqual = React.useCallback((left: ReturnType<typeof readSnapshot>, right: ReturnType<typeof readSnapshot>) =>
        left.online === right.online && left.offline === right.offline && left.unknown === right.unknown, []);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, areEqual);
}

/** Badge reachability is a projection of the same membership as the collection. */
export function useMachineFleetPresence(
    groups: readonly CollectionPresenceGroup[],
    managedByServerId?: Parameters<typeof buildMachineCollection>[0]['managedByServerId'],
    managedFirstAnswerPending = false,
) {
    const sources = React.useMemo(() => groups.map(group => ({
        serverId: group.serverId, accountScope: group.accountScope,
        readMachines: () => group.machines, machineIds: group.machines.map(machine => machine.id),
    })), [groups]);
    return useMachineCollectionPresence(sources, managedByServerId, managedFirstAnswerPending);
}

/** This Home's badges need membership and reachability without building collection rows. */
export function useHomeMachineCollectionPresence() {
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId;
    const serverIds = React.useMemo(() => serverId ? [serverId] : [], [serverId]);
    const inventory = useManagedMachineInventory(serverIds, undefined, undefined, true);
    const store = getStorage();
    // The closed rail and Settings leaf subscribe to the count, so metadata and heartbeat-only
    // changes cannot redraw them. Resolve the same exact Home for both enrollment and managed inventory.
    const sources = React.useMemo(() => scope ? [{
        serverId: scope.serverId, accountScope: scope,
        readMachines: () => selectVisibleMachineInventory(resolveMachinesForActiveServerFromState(store.getState(), scope)),
    }] : [], [scope, store]);
    return useMachineCollectionPresence(sources, inventory.machinesByServerId, inventory.firstAnswerPending);
}

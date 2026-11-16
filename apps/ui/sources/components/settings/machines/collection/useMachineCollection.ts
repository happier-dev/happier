import * as React from 'react';

import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveMachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { describeMachineRuntimePresence } from '@/utils/sessions/machinePresenceLine';
import { reconcileStableRows } from '@/hooks/session/reconcileStableRows';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { selectMachineFleet } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { partitionMachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors, type ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import { readManagedInstallationPrompt } from '../managed/managedCreationPresentation';

import { buildMachineCollection, reconcileMachineCollection, managedMachineConsentKey, machineCollectionRowKey, type MachineCollection, type MachineCollectionRow } from './machineCollectionModel';

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

/** Aggregate presence uses the Home fleet, including enrollments whose creation receipt is archived. */
export function useMachineFleetPresence(groups: readonly ActiveSelectionMachineGroup[]) {
    const members = React.useMemo(() => groups.flatMap(group => selectMachineFleet(group.machines)
        .map(machine => ({ serverId: group.serverId, scope: group.accountScope, machine }))), [groups]);
    const readMachines = React.useCallback(() => members.map(member => member.machine), [members]);
    const readSnapshot = React.useCallback((nowMs: number) => partitionMachineFleetPresence(members,
        member => resolveMachineFleetPresence(member.scope, member.machine, nowMs)).counts, [members]);
    const targets = React.useMemo(() => groups.map(group => ({ serverId: group.serverId,
        machineIds: selectMachineFleet(group.machines).map(machine => machine.id) })), [groups]);
    const areEqual = React.useCallback((left: ReturnType<typeof readSnapshot>, right: ReturnType<typeof readSnapshot>) =>
        left.online === right.online && left.offline === right.offline && left.unknown === right.unknown, []);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, areEqual);
}

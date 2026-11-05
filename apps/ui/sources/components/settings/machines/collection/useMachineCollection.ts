import * as React from 'react';

import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { reconcileStableRows } from '@/hooks/session/reconcileStableRows';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { buildMachineCollection, reconcileMachineCollection, machineCollectionRowKey, type MachineCollection, type MachineCollectionRow } from './machineCollectionModel';

/** Structural inventory changes rebuild the collection; presence belongs to its visible leaves. */
export function useMachineCollection(input: Omit<Parameters<typeof buildMachineCollection>[0], 'nowMs'>): MachineCollection {
    const language = usePreferredLanguage();
    const { groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent } = input;
    const published = React.useRef<MachineCollection | null>(null);
    // The collection is rebuilt from its inputs; rows are reconciled by key against the one published last,
    // so every consumer (index, rail, popover) sees one new row for one changed Machine.
    return React.useMemo(() => {
        published.current = reconcileMachineCollection(published.current, buildMachineCollection({
            groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent, nowMs: Date.now(),
        }));
        return published.current;
    }, [language, groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent]);
}

/** Row badges and aggregate badges share the same canonical presence projection. */
export function useMachineCollectionPresenceRows(rows: readonly MachineCollectionRow[]): readonly MachineCollectionRow[] {
    const readMachines = React.useCallback(() => rows.flatMap(row => row.presenceSource ? [row.presenceSource.machine] : []), [rows]);
    const previous = React.useRef<readonly MachineCollectionRow[]>(rows);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const next = rows.map(row => {
            const source = row.presenceSource;
            if (!source) return row;
            const presence = describeMachinePresenceLine(source.machine, nowMs, source.managedPresence, source.scope);
            return row.online === presence.online && row.status === presence.status && row.presence === presence.label
                ? row : { ...row, online: presence.online, status: presence.status, presence: presence.label };
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

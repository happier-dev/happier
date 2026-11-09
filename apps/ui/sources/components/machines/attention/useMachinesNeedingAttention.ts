import * as React from 'react';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import {
    describeMachineAttentionWord,
    describeMachineReasonPhrase,
    readMachinePublishedResources,
    resolveMachineReasonAction,
    selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachineResourceFleetAttention } from '@/sync/domains/machines/resources/useMachineResourceFleetAttention';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

export type MachineNeedingAttention = Readonly<{
    serverId: string;
    machineId: string;
    /** "edge-1 is short on memory". */
    title: string;
    /** The reason in a word or two ("Short on memory"), for saying one reason once across Machines. */
    word: string;
    actionLabel: string;
    /** The tab its action opens; `null` opens the machine. */
    tab: MachinePageTabParams | null;
}>;

/**
 * The machines that need you now, as always-mounted surfaces list them (Home's and Settings' "Needs your
 * attention", MPG-23): who and why, with the one action. It follows the fleet's string-keyed projection
 * and reads only those machines' names and reasons, as one string, so an unrelated update renders nothing.
 */
export function useMachinesNeedingAttention(): readonly MachineNeedingAttention[] {
    const fleet = useMachineResourceFleetAttention();
    const keysJson = JSON.stringify(fleet.needsYou);
    const json = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => {
        const keys = JSON.parse(keysJson) as { serverId?: string | null; machineId: string }[];
        const rows = keys.flatMap((key) => {
            const machine = resolveServerScopedMachine(state, key.serverId ?? null, key.machineId);
            const published = machine ? readMachinePublishedResources(machine.daemonState) : null;
            const reason = published ? selectHeadlineReason(published.attention) : null;
            return machine && reason ? [{ key, machine, reason }] : [];
        });
        // These rows are read together, so machines that share a name are told apart by the list's
        // own name resolver (host, else a short id), never by a local suffix rule.
        const names = resolveMachineDisplayNames(rows.map((row) => row.machine));
        return JSON.stringify(rows.map(({ key, machine, reason }): MachineNeedingAttention => {
            const action = resolveMachineReasonAction(reason);
            return {
                serverId: key.serverId ?? '',
                machineId: key.machineId,
                title: describeMachineReasonPhrase(names.get(machine.id) ?? getMachineDisplayName(machine), reason),
                word: describeMachineAttentionWord(reason),
                actionLabel: action?.label ?? t('machineAttention.actions.review'),
                tab: action?.tab ?? null,
            };
        }));
    }, [keysJson]));
    return React.useMemo(() => JSON.parse(json) as MachineNeedingAttention[], [json]);
}

export type MachinesNeedingAttentionSummary = Readonly<{
    title: string;
    actionLabel: string;
    /** The one machine its action opens; `null` opens the list of machines. */
    machine: Readonly<{ serverId: string; machineId: string; tab: MachinePageTabParams | null }> | null;
}>;

/**
 * The machines that need you as one fact, the way every summary surface reads them (Home's and
 * Settings' attention, the rail): one machine by its name and reason with its action, several as a
 * count that opens the list of machines. `null` when none does.
 */
export function summarizeMachinesNeedingAttention(rows: readonly MachineNeedingAttention[]): MachinesNeedingAttentionSummary | null {
    if (rows.length === 0) return null;
    if (rows.length === 1) {
        const [row] = rows;
        return { title: row!.title, actionLabel: row!.actionLabel, machine: { serverId: row!.serverId, machineId: row!.machineId, tab: row!.tab } };
    }
    return { title: t('machineAttention.rail.needYouCount', { count: rows.length }), actionLabel: t('settingsOverview.review'), machine: null };
}

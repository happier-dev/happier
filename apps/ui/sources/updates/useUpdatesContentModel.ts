import * as React from 'react';
import { useRouter } from 'expo-router';

import { useReleaseNotesLauncher, useReleaseNotesUnread } from '@/changelog/releaseNotes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { ensureMachineUpdateFactsBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';

import { buildMachineUpdateGroups, readUpdatableInstallables, type UpdatesGroup } from './buildMachineUpdateGroups';
import { buildUpdatesSummary, type UpdatesSummary } from './items/buildUpdatesSummary';
import type { UpdateItem } from './items/updateItem';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { markUpdateCompletionsSeen, refreshMachineUpdateFacts, runMachineItemUpdate, useMachineUpdateRuns, useUnseenUpdateCompletions, useUpdateBatch, useUpdateCheck, type UpdateAllProgress } from './machineUpdateRuns';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

export type { UpdatesGroup };

export type { UpdateAllProgress } from './machineUpdateRuns';

export type UpdatesContentModel = Readonly<{
    summary: UpdatesSummary;
    groups: readonly UpdatesGroup[];
    /** The newest check behind these rows: the app's own, or any machine's update facts. */
    checkedAt: number | null;
    /** Online machines whose tools have not all answered yet (the header's "not checked" line). */
    uncheckedMachineCount: number;
    /** Machines with sessions running now: their service-restarting rows say so, quietly. */
    sessionsRunningOn: ReadonlySet<string>;
    runItem: (item: UpdateItem) => Promise<void>;
    updateAll: () => Promise<void>;
    stopAfterCurrent: () => void;
    batch: UpdateAllProgress | null;
    checking: boolean;
    checkNow: () => void;
    skipAppVersion: (() => void) | null;
    /** Release notes stay reachable from the This app group (R13 (e)). */
    openWhatsNew: () => void;
    whatsNewUnread: boolean;
}>;

/** The machines with an active session, as one stable key (the canonical session state). */
function selectSessionsRunningKey(state: ReturnType<typeof storage.getState>): string {
    const ids = new Set<string>();
    for (const session of Object.values(state.sessions)) {
        const machineId = session.active ? resolveSessionMachineId(session.metadata ?? null) : null;
        if (machineId) ids.add(machineId);
    }
    return [...ids].sort().join('\u0000');
}

/**
 * The Updates surface's detail model, mounted only while the popover or the screen is open
 * (`apps/ui/AGENTS.md`): it asks each online machine for its agent CLI and helper versions through
 * the machine capability cache's own freshness policy, lists every row in the fixed order
 * This app → This computer → other machines, and runs actions through their canonical executors.
 */
export function useUpdatesContentModel(): UpdatesContentModel {
    const router = useRouter();
    const app = useAppUpdateStatus();
    const appItem = app.model.item;
    const thisComputer = useThisComputerCliUpdate();
    const machines = useAllMachines();
    // One server scope for the rows, their facts, their runs and their refreshes.
    const serverId = useActiveServerSnapshot().serverId;
    const activeScope = useActiveServerAccountScope();
    const updateScope = activeScope?.serverId === serverId ? activeScope : null;
    const runs = useMachineUpdateRuns(serverId);
    const releaseNotes = useReleaseNotesUnread();
    const releaseNotesLauncher = useReleaseNotesLauncher();

    const installables = React.useMemo(readUpdatableInstallables, []);

    const onlineMachineIds = React.useMemo(() => {
        const ids = machines.filter((machine) => machine.id !== thisComputer.machineId && isMachineOnline(machine)).map((machine) => machine.id);
        if (thisComputer.machineId) ids.unshift(thisComputer.machineId);
        return ids;
    }, [machines, thisComputer.machineId]);
    const onlineKey = onlineMachineIds.join('\u0000');
    // Every machine's cached detect (offline ones keep their last-known rows); only online ones are asked.
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds);
    // Opening the surface asks each online machine through the cache's existing freshness policy.
    React.useEffect(() => {
        void ensureMachineUpdateFactsBackground({ serverId, machineIds: onlineKey ? onlineKey.split('\u0000') : [] });
    }, [onlineKey, serverId]);

    const { groups, remotes, uncheckedMachineCount, factsCheckedAt } = React.useMemo(() => {
        const built = buildMachineUpdateGroups({
            machines,
            thisMachineId: thisComputer.machineId,
            thisComputerItem: thisComputer.item,
            runs,
            snapshots,
            installables,
        });
        const app: UpdatesGroup = { id: 'app', kind: 'app', machineName: null, machineId: null, online: true, items: [appItem] };
        return { groups: [app, ...built.groups], remotes: built.remotes, uncheckedMachineCount: built.uncheckedMachineCount, factsCheckedAt: built.checkedAt };
    }, [appItem, installables, machines, runs, snapshots, thisComputer.item, thisComputer.machineId]);

    const allItems = React.useMemo(() => groups.flatMap((group) => group.items), [groups]);
    // Open Updates shows every result, so the pill's "Updated" is seen; a completion that lands
    // while the surface stays open is seen too (its row says so).
    const completions = useUnseenUpdateCompletions(updateScope);
    React.useEffect(() => {
        markUpdateCompletionsSeen(updateScope);
    }, [completions, updateScope]);
    // The same coverage the always-mounted summary ranks with, so the open header never says
    // "Up to date" while the pill says some tools were not checked.
    const summary = React.useMemo(
        () => buildUpdatesSummary(allItems, new Map(), { uncheckedMachineCount }),
        [allItems, uncheckedMachineCount],
    );

    const lastUpdateSignatureByMachine = React.useMemo(
        () => new Map(remotes.map((remote) => [remote.machine.id, remote.lastUpdateSignature])),
        [remotes],
    );
    const executeItem = React.useCallback(async (item: UpdateItem) => {
        if (item.subject.kind === 'app') return app.run();
        if (item.subject.kind === 'happier-cli' && item.machineId === thisComputer.machineId) return thisComputer.run();
        const machineId = item.machineId;
        if (!machineId || !updateScope) return;
        await runMachineItemUpdate(item, { scope: updateScope, lastUpdateSignature: lastUpdateSignatureByMachine.get(machineId) });
    }, [app, lastUpdateSignatureByMachine, thisComputer, updateScope]);

    // Pressing Update (or Update all) is the consent: the row runs inline, with its progress in place.
    const runItem = React.useCallback(async (item: UpdateItem) => {
        if (item.action.kind !== 'run') return;
        await executeItem(item);
    }, [executeItem]);

    const { batch, updateAll, stopAfterCurrent } = useUpdateBatch(updateScope, allItems, executeItem);

    const check = React.useCallback(async () => {
        const results = await Promise.allSettled([
            app.checkNow(),
            ...(onlineKey ? onlineKey.split('\u0000') : []).map((machineId) => refreshMachineUpdateFacts(serverId, machineId)),
        ]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
    }, [app.checkNow, onlineKey, serverId]);
    const { checking, checkNow: runCheck } = useUpdateCheck(serverId, check);
    const checkNow = React.useCallback(() => {
        fireAndForget(runCheck(), { tag: 'Updates.checkNow' });
    }, [runCheck]);

    const openWhatsNew = React.useCallback(() => {
        if (releaseNotesLauncher.open()) return;
        router.push('/(app)/changelog');
    }, [releaseNotesLauncher, router]);

    const sessionsRunningKey = storage(selectSessionsRunningKey);
    const sessionsRunningOn = React.useMemo(
        () => new Set(sessionsRunningKey ? sessionsRunningKey.split('\u0000') : []),
        [sessionsRunningKey],
    );
    const checkedAt = app.checkedAt == null && factsCheckedAt == null ? null : Math.max(app.checkedAt ?? 0, factsCheckedAt ?? 0);

    return React.useMemo(() => ({
        summary,
        groups,
        checkedAt,
        uncheckedMachineCount,
        sessionsRunningOn,
        runItem,
        updateAll,
        stopAfterCurrent,
        batch,
        checkNow,
        checking,
        skipAppVersion: app.skipVersion,
        openWhatsNew,
        whatsNewUnread: releaseNotes.hasUnread,
    }), [app.skipVersion, batch, checkNow, checkedAt, checking, groups, openWhatsNew, releaseNotes.hasUnread, runItem, sessionsRunningOn, stopAfterCurrent, summary, uncheckedMachineCount, updateAll]);
}

import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { selectMachineAgentUpdateFacts, useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMachineCliUpdateFacts } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import { buildUpdatesSummary, isSameUpdatesSummary, type UpdatesSummary } from './items/buildUpdatesSummary';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { useMachineUpdateRuns, useUnseenUpdateCompletions } from './machineUpdateRuns';
import { buildMachineUpdateGroups, readUpdatableInstallables } from './buildMachineUpdateGroups';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

const SUMMARY_SNAPSHOT_READING = { ignoreCheckTimes: true } as const;

/**
 * The stable summary every always-mounted entry reads (sidebar pill, collapsed rail, phone header,
 * Settings row, tray). It classifies through the same builders the Updates surface lists, from
 * facts already on this device — no RPC: this app, this computer's Happier CLI, every machine's
 * Happier CLI from its metadata (K5), Agent CLIs from their canonical inventory, and helper latest
 * versions from the capability cache (K6).
 */
export function useUpdatesSummary(): UpdatesSummary {
    const app = useAppUpdateStatus();
    const thisComputer = useThisComputerCliUpdate();
    // The server these machines belong to: its runs and its cached detects, never another server's.
    const serverId = useActiveServerSnapshot().serverId;
    const activeScope = useActiveServerAccountScope();
    const updateScope = activeScope?.serverId === serverId ? activeScope : null;
    const { machineIds, facts: machineFacts } = useMachineCliUpdateFacts(serverId);
    const runs = useMachineUpdateRuns(serverId);
    const completions = useUnseenUpdateCompletions(updateScope);
    // Observes (never fetches) the cached detects: K6 agent facts and helper latest versions that
    // the installables background owner keeps fresh, and each daemon's `tool.systemTasks` kinds.
    const machineAgents = useMachineAgentsByMachine({ serverId, machineIds, load: false,
        alwaysOnlineMachineId: thisComputer.machineId }, selectMachineAgentUpdateFacts);
    // The summary shows no check time, so a re-detect that only moved one does not re-render the shell.
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds, updateScope?.accountId, SUMMARY_SNAPSHOT_READING);
    const installables = React.useMemo(readUpdatableInstallables, []);
    const summary = React.useMemo(() => {
        const { groups, uncheckedMachineCount } = buildMachineUpdateGroups({
            accountScope: updateScope,
            machineFacts,
            thisMachineId: thisComputer.machineId,
            thisComputerItem: thisComputer.item,
            runs,
            machineAgents,
            snapshots,
            installables,
        });
        return buildUpdatesSummary([app.model.item, ...groups.flatMap((group) => group.items)], completions, { uncheckedMachineCount });
    }, [app.model.item, completions, installables, machineAgents, machineFacts, runs, snapshots, thisComputer.item, thisComputer.machineId, updateScope]);
    // Rows change far more often than what the entries show (a newer release of a tool that is
    // already behind, a re-detect with a new check time): same values → same object, for every
    // field, so the always-mounted entries re-render only when something they show changed.
    const published = React.useRef(summary);
    if (!isSameUpdatesSummary(published.current, summary)) published.current = summary;
    return published.current;
}

const NOTHING_TO_SHOW: UpdatesSummary = {
    actionableCount: 0,
    manualCount: 0,
    failedCount: 0,
    runningCount: 0,
    phase: 'none',
    status: 'upToDate',
    visible: false,
};

/** Hosts without the provider (the pet overlay webview) show no Updates entry. */
const UpdatesSummaryContext = React.createContext<UpdatesSummary>(NOTHING_TO_SHOW);

/**
 * Computes the summary once for the whole app shell; every always-mounted entry (sidebar pill,
 * collapsed rail, phone header, Settings row, tray) reads it through `useSharedUpdatesSummary`
 * instead of rebuilding every machine's rows itself (the inbox summary pattern).
 */
export function UpdatesSummaryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const summary = useUpdatesSummary();
    return React.createElement(UpdatesSummaryContext.Provider, { value: summary }, props.children);
}

export function useSharedUpdatesSummary(): UpdatesSummary {
    return React.useContext(UpdatesSummaryContext);
}

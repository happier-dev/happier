import type { MachineAgentUpdateFact } from '@/agents/machineAgents/useMachineAgents';
import { buildMachineUpdateFactsRequest } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableDepDataLike } from '@/capabilities/installablesRegistry';
import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import type { MachineCliUpdateFact } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';

import { buildAgentCliUpdateItem, buildInstallableUpdateItem, buildProbeFailedItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { readCapabilityResultData } from './machineCapabilitySnapshots';
import { observeMachineUpdateRun, type useMachineUpdateRuns } from './machineUpdateRuns';
import { buildRemoteMachineUpdateFacts, buildRemoteMachineUpdateItem, type RemoteMachineUpdateFacts } from './remoteCliUpdateItems';
import { readDisplayedMachineName } from '@/utils/sessions/machineDisplayNames';

export type UpdatesGroup = Readonly<{
    id: string;
    kind: 'app' | 'thisComputer' | 'machine';
    /** The machine's display name (case preserved); `null` for this app. */
    machineName: string | null;
    machineId: string | null;
    online: boolean | null;
    /** Connectivity membership is separate from permission to execute an update. */
    fleetPresence?: MachineFleetPresence;
    executionEligible?: boolean;
    /** When the machine was last seen (its own `activeAt`); `null` for this app and this computer. */
    lastSeenAt: number | null;
    items: readonly UpdateItem[];
}>;

type InstallableEntry = ReturnType<typeof getInstallablesRegistryEntries>[number];

/** Helper installables with a latest-version check of their own (pinned runtimes follow the CLI). */
export function readUpdatableInstallables(): readonly InstallableEntry[] {
    return getInstallablesRegistryEntries().filter((entry) => entry.shouldPrefetchLatestVersion({}));
}

function buildMachineRows(params: Readonly<{
    machineId: string;
    online: boolean | null;
    agents: readonly MachineAgentUpdateFact[];
    snapshot: MachineCapabilitiesSnapshot | null;
    runs: ReturnType<typeof useMachineUpdateRuns>;
    installables: readonly InstallableEntry[];
}>): UpdateItem[] {
    const rows: UpdateItem[] = [];
    for (const agent of params.agents) {
        if (agent.state === 'unknown') {
            // The inventory has no known facts for this agent: "Couldn't check", never "up to date".
            rows.push(buildProbeFailedItem({
                machineId: params.machineId,
                subject: { kind: 'agent-cli', agentId: agent.agentId },
                title: agent.title,
                online: params.online,
            }));
            continue;
        }
        const row = buildAgentCliUpdateItem({
            machineId: params.machineId,
            agent,
            online: params.online,
            task: observeMachineUpdateRun(params.runs, `${params.machineId}:agent:${agent.agentId}`),
        });
        if (row) rows.push(row);
    }
    for (const entry of params.installables) {
        if (isProbeFailed(params.snapshot, entry.capabilityId)) {
            // Same for a helper: a failed check is listed as "Couldn't check", it never vanishes.
            rows.push(buildProbeFailedItem({
                machineId: params.machineId,
                subject: { kind: 'installable', key: entry.key },
                title: entry.title,
                online: params.online,
            }));
            continue;
        }
        const row = buildInstallableUpdateItem({
            machineId: params.machineId,
            installableKey: entry.key,
            title: entry.title,
            online: params.online,
            data: readCapabilityResultData(params.snapshot, entry.capabilityId) as InstallableDepDataLike | null,
            task: observeMachineUpdateRun(params.runs, `${params.machineId}:installable:${entry.key}`),
        });
        if (row) rows.push(row);
    }
    return rows;
}

type MachineUpdateGroupInputs = Readonly<{
    accountScope: ServerAccountScope | null;
    thisMachineId: string | null;
    thisComputerItem: UpdateItem | null;
    runs: ReturnType<typeof useMachineUpdateRuns>;
    machineAgents: ReadonlyMap<string, readonly MachineAgentUpdateFact[]>;
    snapshots: ReadonlyMap<string, MachineCapabilitiesSnapshot | null>;
    installables?: readonly InstallableEntry[];
}> & (Readonly<{ machines: readonly Machine[]; machineFacts?: never }>
    | Readonly<{ machineFacts: readonly MachineCliUpdateFact[]; machines?: never }>);

/**
 * Both Updates readers use the same item policy and already-observed facts. Only
 * the open surface requests display names, sorting and last-seen presentation.
 */
export function buildMachineUpdateGroups(params: MachineUpdateGroupInputs): Readonly<{
    groups: UpdatesGroup[];
    remotes: RemoteMachineUpdateFacts[];
    uncheckedMachineCount: number;
    /** The newest answer to the update-facts request on any machine; `null` when none is cached. */
    checkedAt: number | null;
}> {
    const installables = params.installables ?? readUpdatableInstallables();
    const groups: UpdatesGroup[] = [];
    const machineId = params.thisMachineId;
    if (machineId || params.thisComputerItem) {
        const own = params.machines?.find((machine) => machine.id === machineId);
        groups.push({
            id: 'thisComputer',
            kind: 'thisComputer',
            // Without a name this group is titled "This computer", so absence stays absent.
            machineName: params.machines ? readDisplayedMachineName(own) : null,
            machineId,
            online: true,
            lastSeenAt: null,
            items: [
                ...(params.thisComputerItem ? [params.thisComputerItem] : []),
                ...(machineId
                    ? buildMachineRows({ machineId, online: true, agents: params.machineAgents.get(machineId) ?? [], snapshot: params.snapshots.get(machineId) ?? null, runs: params.runs, installables })
                    : []),
            ],
        });
    }
    // The closed summary has no name, sorting or last-seen demand. It consumes
    // only the Machine owner's selected update facts through the same item policy.
    const remotes = params.machines
        ? buildRemoteMachineUpdateFacts(params.machines, machineId, params.runs, params.snapshots, params.accountScope) : [];
    const remoteRows = params.machineFacts
        ? params.machineFacts.filter(machine => machine.id !== machineId && (machine.metadataPresent || machine.fleetPresence.member)).map(machine => ({
            id: machine.id, name: null, online: machine.online, fleetPresence: machine.fleetPresence,
            lastSeenAt: null,
            ...buildRemoteMachineUpdateItem(machine, params.runs, params.snapshots.get(machine.id) ?? null),
        }))
        : remotes.map(remote => {
            const activeAt = readMachineActivity(remote.machine).activeAt;
            return { id: remote.machine.id, name: remote.name, online: remote.online, fleetPresence: remote.fleetPresence,
                executionOnline: remote.executionOnline,
                lastSeenAt: typeof activeAt === 'number' && activeAt > 0 ? activeAt : null, cliItem: remote.cliItem };
        });
    for (const remote of remoteRows) {
        groups.push({
            id: `machine:${remote.id}`,
            kind: 'machine',
            machineName: remote.name,
            machineId: remote.id,
            online: remote.online,
            fleetPresence: remote.fleetPresence,
            executionEligible: remote.executionOnline === true,
            lastSeenAt: remote.lastSeenAt,
            items: [
                remote.cliItem,
                ...buildMachineRows({
                    machineId: remote.id,
                    online: remote.executionOnline,
                    agents: params.machineAgents.get(remote.id) ?? [],
                    snapshot: params.snapshots.get(remote.id) ?? null,
                    runs: params.runs,
                    installables,
                }),
            ],
        });
    }
    // Coverage: an online machine is checked only once it answered every capability the update-facts
    // request asks (a missing answer is "not checked"; a failed one is its own "Couldn't check" row).
    const requestedIds = [...new Set((buildMachineUpdateFactsRequest().requests ?? []).map((request) => request.id))];
    const uncheckedMachineCount = groups.filter((group) => (
        group.machineId != null && group.online && group.executionEligible !== false && !hasAnswered(params.snapshots.get(group.machineId) ?? null, requestedIds)
    )).length;
    let checkedAt: number | null = null;
    for (const group of groups) {
        const snapshot = group.machineId != null ? params.snapshots.get(group.machineId) ?? null : null;
        for (const id of requestedIds) {
            const answeredAt = readProbe(snapshot, id)?.checkedAt;
            if (typeof answeredAt === 'number' && answeredAt > (checkedAt ?? 0)) checkedAt = answeredAt;
        }
    }
    return { groups, remotes, uncheckedMachineCount, checkedAt };
}

type SnapshotResults = MachineCapabilitiesSnapshot['response']['results'];

function readProbe(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): SnapshotResults[keyof SnapshotResults] | undefined {
    return snapshot?.response.results[capabilityId as keyof SnapshotResults];
}

function isProbeFailed(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): boolean {
    const probe = readProbe(snapshot, capabilityId);
    return probe != null && !probe.ok;
}

function hasAnswered(snapshot: MachineCapabilitiesSnapshot | null, capabilityIds: readonly string[]): boolean {
    return capabilityIds.every((id) => readProbe(snapshot, id) != null);
}

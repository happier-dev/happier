import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveMachineFleetPresence, type MachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import type { MachineCliUpdateFact } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import { buildRemoteCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { readRemoteCliUpdateAdvertised } from './machineCapabilitySnapshots';
import { observeMachineUpdateRun, signatureOfLastUpdate } from './machineUpdateRuns';
import type { useMachineUpdateRuns } from './machineUpdateRuns';

export type RemoteMachineUpdateFacts = Readonly<{
    machine: Machine;
    name: string;
    online: boolean | null;
    fleetPresence: MachineFleetPresence;
    executionOnline: boolean | null;
    cliItem: UpdateItem;
    lastUpdateSignature: string;
}>;

/** Shared CLI classification; names and full Machine rows belong to presented detail only. */
export function buildRemoteMachineUpdateItem(
    machine: MachineCliUpdateFact,
    runs: ReturnType<typeof useMachineUpdateRuns>,
    snapshot: MachineCapabilitiesSnapshot | null,
): Readonly<{ cliItem: UpdateItem; lastUpdateSignature: string; executionOnline: boolean | null }> {
    const facts = machine.cliUpdate;
    const lastUpdateSignature = signatureOfLastUpdate(facts?.lastUpdate ?? null);
    const executionOnline = machine.online === false ? false : machine.executionEligible === false ? null : machine.online;
    const cliItem = buildRemoteCliUpdateItem({
        machineId: machine.id,
        title: t('updates.happierCliTitle'),
        online: executionOnline,
        platform: machine.platform,
        happyCliVersion: machine.happyCliVersion,
        facts,
        remoteUpdateAdvertised: facts?.canUpdateRemotely === true ? readRemoteCliUpdateAdvertised(snapshot) : false,
        task: observeMachineUpdateRun(runs, `${machine.id}:happier-cli`, { lastUpdateSignature }),
    });
    return { cliItem, lastUpdateSignature, executionOnline };
}

/**
 * Every other machine's Happier CLI row, from machine metadata alone (K5 `cliUpdate`, else the
 * `happyCliVersion` every released daemon writes) — no RPC, so the always-mounted summary and the
 * open surface both use it. Remote Update is offered only when the machine says it can update itself
 * (`canUpdateRemotely`) AND its daemon lists `cli.update.v1` among its `tool.systemTasks` kinds.
 */
export function buildRemoteMachineUpdateFacts(
    machines: readonly Machine[],
    thisMachineId: string | null,
    runs: ReturnType<typeof useMachineUpdateRuns>,
    /** Cached capability detects (never fetched here) — the `tool.systemTasks` kinds live there. */
    snapshots: ReadonlyMap<string, MachineCapabilitiesSnapshot | null>,
    accountScope: ServerAccountScope | null,
): RemoteMachineUpdateFacts[] {
    const result: RemoteMachineUpdateFacts[] = [];
    // The one owner of names shown together: two machines that share a name get "· f98b".
    const names = resolveMachineDisplayNames(machines);
    for (const machine of machines) {
        if (machine.id === thisMachineId) continue;
        const fleetPresence = resolveMachineFleetPresence(accountScope, machine);
        if (!machine.metadata && !fleetPresence.member) continue;
        const online = fleetPresence.online;
        const executionEligible = isMachineSelectableForFleet(accountScope, machine);
        const { cliItem, lastUpdateSignature, executionOnline } = buildRemoteMachineUpdateItem({ id: machine.id, online,
            fleetPresence, executionEligible,
            metadataPresent: Boolean(machine.metadata), platform: machine.metadata?.platform ?? null,
            happyCliVersion: machine.metadata?.happyCliVersion || null, cliUpdate: machine.metadata?.cliUpdate ?? null,
        }, runs, snapshots.get(machine.id) ?? null);
        result.push({ machine, name: names.get(machine.id) ?? machine.id, online, fleetPresence, executionOnline, cliItem, lastUpdateSignature });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

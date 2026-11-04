import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef,
    type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { PluginMachineSourceExecutionOriginCandidateV1, PluginMachineExecutionOriginRejectionV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginUiProjectionModel } from './projection';
import { readPluginUiContributionSupplies, type PluginUiContributionSupplyV1, type PluginUiContributionOriginV1 } from './projectionOrigins';

export type PluginUiExecutionOriginCandidateFacts = Readonly<{
    establishingTargets: readonly MachineAdministrationTargetV1[];
    sourceCandidates: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins: readonly PluginMachineExecutionOriginV1[];
    machineRejections: readonly PluginMachineExecutionOriginRejectionV1[];
    autoPick: boolean;
    renderedVersion?: string;
}>;

/** Accumulators belong to one derivation; only the resulting immutable facts survive. */
export function derivePluginUiExecutionOriginCandidateFacts(
    params: Readonly<{ projection: PluginUiProjectionModel | null; pluginId: string; previous?: PluginUiExecutionOriginCandidateFacts }>,
    entries: readonly unknown[],
    packageSupplies: readonly PluginUiContributionSupplyV1[],
): PluginUiExecutionOriginCandidateFacts {
    const sourceCandidates: PluginMachineSourceExecutionOriginCandidateV1[] = [];
    const declaredDefaultOrigins: PluginMachineExecutionOriginV1[] = [];
    const machineRejections: PluginMachineExecutionOriginRejectionV1[] = [];
    const establishingTargets: MachineAdministrationTargetV1[] = [...(params.projection?.establishingExecutionTargetsByPluginId?.[params.pluginId] ?? [])];
    const establishingKeys = new Map<string, Set<string>>();
    for (const target of establishingTargets) addTarget(establishingKeys, target.serverIdentityId, target.machineId);
    const rejectionKeys = new Map<string, Set<string>>();
    const defaultOrigins: OriginGroups = new Map();
    const sourceOrigins: OriginGroups = new Map();
    const supplyGroups = [
        ...entries.map(entry => ({ conflict: hasConflict(entry), supplies: readPluginUiContributionSupplies(entry) })),
        { conflict: entries.some(entry => hasConflict(entry)), supplies: packageSupplies },
    ];
    for (const { conflict, supplies } of supplyGroups) {
        for (const supply of supplies) {
            if (supply.phase === 'establishing' && supply.serverIdentityId
                && addTarget(establishingKeys, supply.serverIdentityId, supply.machineId)) {
                establishingTargets.push({ serverIdentityId: supply.serverIdentityId, machineId: supply.machineId });
            }
            const origin = supply.executionOrigin;
            const reason = readPluginUiSupplyRejection(supply);
            const serverIdentityId = origin?.serverIdentityId ?? supply.serverIdentityId;
            if (reason && serverIdentityId && addTarget(rejectionKeys, serverIdentityId, supply.machineId)) {
                machineRejections.push({ serverIdentityId, machineId: supply.machineId, reason });
            }
            if (!origin || getPluginMachineExecutionOriginRef(origin).pluginId !== params.pluginId) continue;
            if (supply.executionTargetDefault && !conflict
                && appendFirstOrigin(defaultOrigins, origin)) declaredDefaultOrigins.push(origin);
            if (!('sourceRef' in origin) || !supply.occurrenceId || !supply.pluginVersion
                || !supply.serverId
                || !appendFirstOrigin(sourceOrigins, origin)) continue;
            sourceCandidates.push(Object.freeze({
                source: Object.freeze({ origin, version: supply.pluginVersion, occurrenceId: supply.occurrenceId,
                    serverId: supply.serverId }),
                // A machine-local source is selected by exact custody, not by
                // correspondence with another Machine's portable release.
                releaseContent: 'matched',
                validation: reason ? { kind: 'rejected' as const, reason }
                    : supply.phase === 'current' && supply.interactionEnabled ? { kind: 'admitted' as const }
                        : { kind: 'rejected' as const, reason: 'stale' as const },
            }));
        }
    }
    const installed = params.projection?.installedPackagesById[params.pluginId];
    const autoPick = installed ? installed.executionTarget?.autoPick !== false
        : !supplyGroups.some(({ supplies }) => supplies.some(supply => supply.executionTargetAutoPick === false));
    const renderedVersion = installed?.version;
    const previous = params.previous;
    // Each fact keeps its published identity while its own content is unchanged,
    // so a change to one fact never re-derives its consumers' unrelated inputs.
    const establishing = previous && sameTargets(previous.establishingTargets, establishingTargets)
        ? previous.establishingTargets : Object.freeze(establishingTargets);
    const sources = previous && sameSourceCandidates(previous.sourceCandidates, sourceCandidates)
        ? previous.sourceCandidates : Object.freeze(sourceCandidates);
    const defaults = previous && previous.declaredDefaultOrigins.length === declaredDefaultOrigins.length
        && declaredDefaultOrigins.every((origin, index) => arePluginMachineExecutionOriginsEqual(origin, previous.declaredDefaultOrigins[index]!))
        ? previous.declaredDefaultOrigins : Object.freeze(declaredDefaultOrigins);
    const rejections = previous && previous.machineRejections.length === machineRejections.length
        && machineRejections.every((rejection, index) => {
            const other = previous.machineRejections[index]!;
            return rejection.serverIdentityId === other.serverIdentityId && rejection.machineId === other.machineId
                && rejection.reason === other.reason;
        }) ? previous.machineRejections : Object.freeze(machineRejections);
    if (previous && previous.autoPick === autoPick && previous.renderedVersion === renderedVersion
        && establishing === previous.establishingTargets && sources === previous.sourceCandidates
        && defaults === previous.declaredDefaultOrigins && rejections === previous.machineRejections) return previous;
    return Object.freeze({ establishingTargets: establishing, sourceCandidates: sources, declaredDefaultOrigins: defaults,
        // The rendered declaration owns policy. An older replica's opt-out
        // cannot change the current rendered release's automatic placement.
        autoPick,
        ...(renderedVersion ? { renderedVersion } : {}),
        machineRejections: rejections });
}

function sameTargets(left: readonly MachineAdministrationTargetV1[], right: readonly MachineAdministrationTargetV1[]): boolean {
    return left.length === right.length && right.every((target, index) => target.serverIdentityId === left[index]!.serverIdentityId
        && target.machineId === left[index]!.machineId);
}

function sameSourceCandidates(left: readonly PluginMachineSourceExecutionOriginCandidateV1[],
    right: readonly PluginMachineSourceExecutionOriginCandidateV1[]): boolean {
    return left.length === right.length && right.every((candidate, index) => {
        const other = left[index]!;
        return candidate.source.serverId === other.source.serverId
            && candidate.source.version === other.source.version
            && candidate.source.occurrenceId === other.source.occurrenceId
            && arePluginMachineExecutionOriginsEqual(candidate.source.origin, other.source.origin)
            && candidate.releaseContent === other.releaseContent
            && candidate.validation.kind === other.validation.kind
            && (candidate.validation.kind !== 'rejected'
                || (other.validation.kind === 'rejected' && candidate.validation.reason === other.validation.reason));
    });
}

function hasConflict(entry: unknown): boolean {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry) && 'hostCompatibility' in entry && entry.hostCompatibility === 'conflict';
}

/** Keep the two identity fields separate; never serialize a tuple for a lookup. */
function addTarget(groups: Map<string, Set<string>>, serverIdentityId: string, machineId: string): boolean {
    const machines = groups.get(serverIdentityId);
    if (machines?.has(machineId)) return false;
    if (machines) machines.add(machineId);
    else groups.set(serverIdentityId, new Set([machineId]));
    return true;
}

type OriginGroups = Map<string, Map<string, PluginMachineExecutionOriginV1[]>>;

/** Routing narrows comparisons; exact custody/materialization equality remains canonical. */
function appendFirstOrigin(groups: OriginGroups, origin: PluginMachineExecutionOriginV1): boolean {
    let machines = groups.get(origin.serverIdentityId);
    const machineId = getPluginMachineExecutionOriginRef(origin).machineId;
    const group = machines?.get(machineId);
    if (group?.some(candidate => arePluginMachineExecutionOriginsEqual(candidate, origin))) return false;
    if (group) group.push(origin);
    else {
        if (!machines) { machines = new Map(); groups.set(origin.serverIdentityId, machines); }
        machines.set(machineId, [origin]);
    }
    return true;
}

function readPluginUiSupplyRejection(supply: PluginUiContributionOriginV1): PluginMachineExecutionOriginRejectionV1['reason'] | null {
    switch (supply.unavailableReasonCode) {
        case 'plugin_machine_unreachable': return 'home_unreachable';
        case 'plugin_daemon_unsupported': return 'daemon_unsupported';
        case 'plugin_daemon_invalid_response': return 'daemon_invalid_response';
        case 'plugin_daemon_unavailable': return 'daemon_unavailable';
        case 'plugin_activation_failed': return 'activation_refused';
        case 'plugin_source_not_ready': return 'source_not_ready';
        default: return null;
    }
}


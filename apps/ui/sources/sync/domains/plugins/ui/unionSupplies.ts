import { arePluginMachineExecutionOriginsEqual, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiProjectionModel } from './projection';
import type { PluginUiProjectionUnionMember } from './projectionUnion';
import { readSelectedPluginUiResourceCapability } from './resourceCapability';
import { readPluginUiContributionSupplies, retainPluginUiProjectionValue,
    type PluginUiContributionOriginV1, type PluginUiContributionSupplyV1 } from './projectionOrigins';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type UnionSupplyFacts = Readonly<{
    facts: Map<UnknownRecord, PluginUiContributionSupplyV1>;
    /** Previous carriers are available only during this synchronous publication. */
    previousFacts?: ReadonlyMap<UnknownRecord, PluginUiContributionSupplyV1>;
}>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** One synchronous union's admitted supply lists and selected producer stamps. */
export function createUnionSupplyPublisher(
    conflictedPluginIds: ReadonlySet<string>,
    selectedMembersByPluginId: ReadonlyMap<string, unknown>,
    selectedOriginsByPluginId: ReadonlyMap<string, PluginMachineExecutionOriginV1>,
    supplyFacts?: ReadonlyMap<PluginUiProjectionUnionMember, UnionSupplyFacts>,
) {
    // Aggregate equivalent declarations without appointing a producer. Exact
    // source facts are retained separately, including offline supplying copies.
    const normalizedSupplies = new Map<PluginUiContributionOriginV1, Readonly<{
        occurrenceId: string | null;
        resourceCapability: ReturnType<typeof readSelectedPluginUiResourceCapability>;
        supply: PluginUiContributionSupplyV1;
    }>>();
    // This synchronous derivation owns its draft lists. Admit/freeze each
    // complete list once, rather than copying and rereading every prefix for
    // each supplying Machine.
    const suppliesByMap = new Map<object, Map<string, { supplies: PluginUiContributionSupplyV1[]; binding: PluginUiContributionSupplyV1 | null }>>();
    const publishFirstAdmitted = <T>(member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>, map: Record<string, T>, key: string, value: T, origin: PluginUiContributionOriginV1,
        retainDeclarationOccurrence = false): void => {
        const model = member.projection;
        const sourceEntry = asRecord(value);
        const pluginId = readString(sourceEntry?.pluginId);
        if (!sourceEntry || !pluginId) return;
        const previous = asRecord(map[key]);
        const installed = model.installedPackagesById[pluginId];
        const sourceCustody = installed?.sourceCustody ?? null;
        const occurrenceId = readString(sourceEntry.occurrenceId);
        const normalized = normalizedSupplies.get(origin);
        const prepared = supplyFacts?.get(member);
        const cached = prepared?.facts.get(sourceEntry);
        const resourceCapability = cached?.resourceCapability ?? readSelectedPluginUiResourceCapability(sourceEntry);
        let supply = cached ?? (normalized?.occurrenceId === occurrenceId
            && normalized.resourceCapability.readable === resourceCapability.readable
            && normalized.resourceCapability.dynamic === resourceCapability.dynamic ? normalized.supply : undefined);
        if (!supply) {
            const rawSupply: PluginUiContributionSupplyV1 = { ...origin, occurrenceId,
                pluginVersion: installed?.version ?? null, sourceCustody,
                executionTargetDefault: installed?.executionTarget?.default === 'installation',
                executionTargetAutoPick: installed?.executionTarget?.autoPick, resourceCapability };
            const parsedSupply = readPluginUiContributionSupplies({ hostSupplies: [rawSupply] })[0];
            if (!parsedSupply) return;
            supply = retainPluginUiProjectionValue(prepared?.previousFacts?.get(sourceEntry), parsedSupply) as PluginUiContributionSupplyV1;
            normalizedSupplies.set(origin, { occurrenceId, resourceCapability, supply });
        }
        if (!cached) prepared?.facts.set(sourceEntry, supply);
        let entries = suppliesByMap.get(map);
        if (!entries) { entries = new Map(); suppliesByMap.set(map, entries); }
        let draft = entries.get(key);
        if (!draft) { draft = { supplies: [], binding: null }; entries.set(key, draft); }
        const { supplies } = draft;
        supplies.push(supply);
        const conflict = conflictedPluginIds.has(pluginId) && !selectedMembersByPluginId.has(pluginId);
        const selected = selectedOriginsByPluginId.get(pluginId);
        // A draft keeps its first selected binding. Each appended supply is
        // compared at most once, without searching the growing prefix again.
        if (!conflict && !draft.binding && selected && supply.executionOrigin
            && arePluginMachineExecutionOriginsEqual(selected, supply.executionOrigin)) draft.binding = supply;
        const binding = conflict ? null : draft.binding;
        // The published row already holds this draft's supply list. Rebuilding it
        // from itself with the same binding would only copy it once per supplier.
        if (previous && binding !== supply) return;
        // Preserve the original stamp's field insertion slot without making a
        // fresh carrier the identity of the immutable authored source row.
        const entry: UnknownRecord = { ...sourceEntry, hostOrigin: origin };
        const representative = binding === supply || !previous ? entry : previous;
        const availability = asRecord(representative.availability);
        map[key] = Object.freeze({
            ...representative,
            // Complete the selected producer stamp so artifact adoption cannot
            // borrow a release version (and byte route) from another supply.
            ...(binding?.pluginVersion ? { pluginVersion: binding.pluginVersion } : {}),
            // The selected supply already owns the validated immutable origin.
            // Do not republish its raw representative and reparse it on reads.
            ...(binding && Object.hasOwn(representative, 'executionOrigin')
                ? { executionOrigin: binding.executionOrigin } : {}),
            // Executable rows may not borrow an unselected replica's runtime
            // identity. Schema declarations retain their separate type identity.
            ...(!binding ? { occurrenceId: retainDeclarationOccurrence && !conflict ? representative.occurrenceId : undefined,
                executionOrigin: undefined } : {}),
            hostOrigin: binding,
            hostSupplies: supplies,
            hostCompatibility: conflict ? 'conflict' : 'compatible',
            // A declaration conflict awaits Administration's exact selection;
            // it is not a terminal denial of this page. Keep the choice visible
            // and let the shared loading UI wait for the selected declaration.
            ...(conflict && availability?.state === 'available'
                ? { availability: Object.freeze({ ...availability, state: 'resolving' }) } : {}),
        }) as T;
    };

    return { publishFirstAdmitted, suppliesByMap };
}


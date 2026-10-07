import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiActionProjection,
    type PluginUiHostedWebProjection,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
    type PluginUiSessionHeaderActionProjection,
    type PluginUiSearchProviderProjection,
    type PluginUiPhysicalSurfacePlacementProjection,
    type PluginUiTranslationsProjection,
    type PluginVoiceProviderProjection,
    type PluginUiDragSourceProjection,
    type PluginUiDropTargetProjection,
    type PluginUiResourceProjection,
    type PluginUiInputTypeProjection,
} from './projection';
import { arePluginMachineExecutionOriginsEqual, PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiProjectionPhase } from './usePluginUiProjectionCurrentness';

type UnknownRecord = Readonly<Record<string, unknown>>;

/**
 * F7 — an app-scope plugin projection is a **union across Administration's
 * exact selected origins**, never a machine chosen by heartbeat recency or by
 * the apparent richness of a projection.
 *
 * `activeAt` is presence data. It is neither user intent nor evidence that the
 * machine owns the wanted contribution, so the previous "online, prefer
 * `active`, newest `activeAt` first, take `[0]`" rule made a plugin installed on
 * machine A disappear the moment machine B sent a keep-alive. "App-scope" means
 * *not machine-specific*: selecting one machine contradicts the name.
 *
 * Availability supplies release facts; Administration resolves those facts to
 * zero, one, or an explicitly selected exact materialization. Contributions
 * without a materialization use Administration's existing Plugin machine
 * target instead. This projection consumes those decisions and only then
 * retains a matching member's contribution. It stamps each retained
 * contribution with that origin machine, generation and interaction authority,
 * so a mount cannot roam because a heartbeat changed.
 */
export const PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY = 'hostOrigin';

/**
 * The host-private effect binding for one projected contribution. It never
 * reaches a plugin: §3.2 keeps machine/account/generation identities host-side
 * and stamps them at effect boundaries, which is exactly what this is.
 */
export type PluginUiContributionOriginV1 = Readonly<{
    machineId: string;
    serverId: string | null;
    /** The ORIGIN machine's projection generation, not the union's. */
    generation: number | null;
    /**
     * Whether the ORIGIN's projection currently holds executable authority.
     *
     * It is carried per contribution, not rolled up, because a roll-up is wrong
     * in both directions: "any member is current" would admit a mount whose own
     * machine is mid-reconnect, and "every member is current" would make one
     * flaky machine silence another's plugins. The cost is that an authority flip
     * republishes the model with an unchanged generation — a content no-op for
     * artifact invalidation, which compares generations and artifact
     * fingerprints and evicts nothing when neither moved.
     */
    interactionEnabled: boolean;
    /** The originating machine's explicit projection state. */
    phase: PluginUiProjectionPhase;
    /**
     * F7's selected materialization identity, copied verbatim from the
     * producer-stamped projection entry. Consumers that need exact ownership
     * (such as launch-input delivery) must fail closed when it is absent.
     */
    executionOrigin: PluginMachineExecutionOriginV1 | null;
}>;

export type PluginUiProjectionUnionMember = Readonly<{
    machineId: string;
    serverId: string | null;
    projection: PluginUiProjectionModel | null;
    phase: PluginUiProjectionPhase;
    interactionEnabled: boolean;
}>;

/**
 * The canonical Administration decision for each plugin that may contribute to
 * the app scope. An absent entry is deliberately meaningful: it covers
 * Availability pre-load, disabled/revoked materializations, conflicts, and the
 * multiple-replica state awaiting an explicit user choice. The union must emit
 * no contribution for it rather than inventing a local fallback.
 */
export type PluginUiProjectionUnionOriginSelections = ReadonlyMap<
    string,
    PluginMachineExecutionOriginV1
>;

export type PluginUiProjectionUnion = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    /** Canonical state for app consumers without a contribution-specific origin. */
    phase: PluginUiProjectionPhase;
    /**
     * Coarse roll-up across selected contributors only. The per-contribution
     * origin is still the authority for an actual mount; this value reaches
     * only consumers that have no contribution in hand.
     */
    interactionEnabled: boolean;
    /**
     * The union's machine, and only when the union HAS one: a single eligible
     * member. With zero or several members there is no single app machine and
     * this is `null` — the honest answer. It is never inferred from `activeAt`.
     */
    machineId: string | null;
    serverId: string | null;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION_UNION: PluginUiProjectionUnion = Object.freeze({
    pluginUiProjection: null,
    phase: 'unavailable',
    interactionEnabled: false,
    machineId: null,
    serverId: null,
});

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readProjectionPhase(value: unknown): PluginUiProjectionPhase | null {
    return value === 'establishing'
        || value === 'current'
        || value === 'retainedOffline'
        || value === 'unavailable'
        ? value
        : null;
}

function resolveUnionProjectionPhase(
    members: readonly PluginUiProjectionUnionMember[],
): PluginUiProjectionPhase {
    // An app catalog is incomplete while any eligible member is still on its
    // first (or replacement) describe. A current *other* member cannot prove
    // that a selected destination is absent from that pending origin, so it
    // must not turn a restored deep link into a tombstone. Published entries
    // retain their own stamped phase below; existing current contributions
    // therefore keep their exact origin authority without making a missing
    // pending contribution appear unavailable.
    if (members.some((member) => member.phase === 'establishing')) return 'establishing';
    if (members.some((member) => member.phase === 'current')) return 'current';
    if (members.some((member) => member.phase === 'retainedOffline')) return 'retainedOffline';
    return 'unavailable';
}

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

/**
 * The origin a unioned contribution carries, or `null` for a contribution that
 * came from a single-machine (session/project/browser/services) projection,
 * where the mount's own machine facts remain authoritative.
 */
export function readPluginUiContributionOrigin(entry: unknown): PluginUiContributionOriginV1 | null {
    const origin = asRecord(asRecord(entry)?.[PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]);
    const machineId = readString(origin?.machineId);
    const phase = readProjectionPhase(origin?.phase);
    if (!origin || !machineId || !phase) {
        return null;
    }
    const executionOrigin = PluginMachineExecutionOriginV1Schema.safeParse(origin.executionOrigin);
    return Object.freeze({
        machineId,
        serverId: readString(origin.serverId),
        generation: typeof origin.generation === 'number' && Number.isFinite(origin.generation)
            ? origin.generation
            : null,
        interactionEnabled: origin.interactionEnabled === true,
        // Phase is stamped by the canonical union producer. A malformed or
        // predecessor in-memory stamp is not allowed to recover authority by
        // inferring currentness from a model or interaction boolean.
        phase,
        executionOrigin: executionOrigin.success ? executionOrigin.data : null,
    });
}

function stamp<T extends UnknownRecord>(entry: T, origin: PluginUiContributionOriginV1): T {
    return Object.freeze({
        ...entry,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: origin,
    }) as T;
}

/**
 * A 32-bit FNV-1a over the members' `machineId=generation` pairs. Used only when
 * several machines contribute, where no member's generation can stand for the
 * whole union: it is a non-negative integer that changes whenever any member's
 * generation changes and is stable otherwise, which is what every consumer of
 * the model-level generation actually needs.
 */
function deriveUnionGeneration(members: readonly PluginUiProjectionUnionMember[]): number {
    let hash = 0x811c9dc5;
    const source = members
        .map((member) => `${member.machineId}=${String(member.projection?.generation ?? 'null')}`)
        .join('\n');
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * The direct V2 producer stamp. This is intentionally parsed as an origin
 * record, not rebuilt from entry/plugin/machine fields: only the projection
 * producer knows which materialization produced an entry.
 */
export function readPluginUiProjectionEntryExecutionOrigin(entry: unknown): PluginMachineExecutionOriginV1 | null {
    const candidate = asRecord(entry);
    const pluginId = readString(candidate?.pluginId);
    if (!candidate || !pluginId) return null;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: candidate.serverIdentityId,
        materializationRef: candidate.materializationRef,
    });
    if (!parsed.success || parsed.data.materializationRef.pluginId !== pluginId) return null;
    return parsed.data;
}

function selectedOriginOwnsEntry(input: Readonly<{
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    entry: unknown;
    machineId: string;
}>): boolean {
    const pluginId = readString(asRecord(input.entry)?.pluginId);
    if (!pluginId) return false;
    const selectedOrigin = input.selectedOriginsByPluginId.get(pluginId);
    const producerOrigin = readPluginUiProjectionEntryExecutionOrigin(input.entry);
    return selectedOrigin !== undefined
        && producerOrigin !== null
        && selectedOrigin.materializationRef.pluginId === pluginId
        && selectedOrigin.materializationRef.machineId === input.machineId
        && producerOrigin.materializationRef.machineId === input.machineId
        && arePluginMachineExecutionOriginsEqual(selectedOrigin, producerOrigin);
}

/**
 * Why a member's entry may contribute to the union, or `null` for one that may
 * not. The two arms are not interchangeable: only an ORIGINLESS contribution
 * may be published without an exact producer stamp.
 */
type PluginUiProjectionUnionEntryAdmission = 'originless' | 'selectedOrigin';

function admitMemberEntry(input: Readonly<{
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>;
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    selectedOriginlessMachineId: string | null;
    conflictedOriginlessPluginIds?: ReadonlySet<string>;
    entry: unknown;
}>): PluginUiProjectionUnionEntryAdmission | null {
    const pluginId = readString(asRecord(input.entry)?.pluginId);
    if (!pluginId) return null;
    // The originless arm.
    //
    // The projection producer stamps an entry only for a plugin it holds a
    // materialization for (`materializationIdsByPluginId`). A plugin the
    // Account can never materialize therefore arrives UNSTAMPED and has
    // nothing for per-plugin materialization selection to select. The existing
    // Plugin Administration machine target supplies that missing machine
    // selection. With no target yet, the sole originless producer remains a
    // safe continuity fallback; replicas stay withheld until the canonical
    // target exists rather than electing a heartbeat/order winner.
    //
    // The discriminator is that STRUCTURAL fact — the producer stamped no
    // materialization — never the plugin's provenance. A plugin shipped inside
    // the host binary and an externally authored plugin the daemon loaded
    // without an Account materialization are in the identical position and are
    // admitted on identical terms. This machine target applies only while the
    // plugin has no per-plugin materialization selection, so it can never
    // shadow the more specific Account-owned origin.
    if (
        !input.selectedOriginsByPluginId.has(pluginId)
        && readPluginUiProjectionEntryExecutionOrigin(input.entry) === null
        && (
            input.selectedOriginlessMachineId !== null
                ? input.member.machineId === input.selectedOriginlessMachineId
                : !input.conflictedOriginlessPluginIds?.has(pluginId)
        )
    ) {
        return 'originless';
    }
    return selectedOriginOwnsEntry({
        selectedOriginsByPluginId: input.selectedOriginsByPluginId,
        entry: input.entry,
        machineId: input.member.machineId,
    })
        ? 'selectedOrigin'
        : null;
}

function memberHasAdmittedContribution(input: Readonly<{
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>;
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    selectedOriginlessMachineId: string | null;
    conflictedOriginlessPluginIds: ReadonlySet<string>;
}>): boolean {
    const owns = (entry: unknown): boolean => admitMemberEntry({
        member: input.member,
        selectedOriginsByPluginId: input.selectedOriginsByPluginId,
        selectedOriginlessMachineId: input.selectedOriginlessMachineId,
        conflictedOriginlessPluginIds: input.conflictedOriginlessPluginIds,
        entry,
    }) !== null;
    const projection = input.member.projection;
    return Object.values(projection.translationsByPluginId).some(owns)
        || Object.values(projection.sessionHeaderActionsById).some(owns)
        || Object.values(projection.searchProvidersById).some(owns)
        || Object.values(projection.hostedWebById).some(owns)
        || Object.values(projection.reactNativeBundlesById).some(owns)
        || Object.values(projection.surfacePlacementsById).some(owns)
        || Object.values(projection.settingsGroupsById).some(owns)
        || Object.values(projection.settingsPagesById).some(owns)
        || Object.values(projection.actionsById).some(owns)
        || Object.values(projection.voiceProvidersById).some(owns)
        || Object.values(projection.dragSourcesById).some(owns)
        || Object.values(projection.dropTargetsById).some(owns)
        || Object.values(projection.inputTypesById).some(entry => entryHasCurrentOccurrence(projection, entry) && owns(entry))
        || Object.values(projection.resourcesById).some(entry => resourceHasCurrentProducerOrigin(projection, entry) && owns(entry))
        || Object.values(projection.unknownEntriesById).some(owns);
}

/** A Resource without a View still has its own producer and current runtime slot. */
function resourceHasCurrentProducerOrigin(projection: PluginUiProjectionModel, entry: PluginUiResourceProjection): boolean {
    return readPluginUiProjectionEntryExecutionOrigin(entry) !== null && entryHasCurrentOccurrence(projection, entry);
}

function entryHasCurrentOccurrence(projection: PluginUiProjectionModel, entry: Readonly<{ pluginId: string; occurrenceId?: string }>): boolean {
    const occurrenceId = readString(entry.occurrenceId);
    const installedPackage = projection.installedPackagesById[entry.pluginId];
    return occurrenceId !== null
        && installedPackage?.enabled === true && installedPackage.occurrenceId === occurrenceId;
}

/**
 * Whether two member lists describe the same union, so the caller can keep the
 * previously built model instead of publishing a new object identity. Member
 * projections are compared by IDENTITY, which is exactly the stability the
 * per-machine currentness owner already guarantees for an unchanged generation.
 */
export function arePluginUiProjectionUnionMembersEquivalent(
    left: readonly PluginUiProjectionUnionMember[],
    right: readonly PluginUiProjectionUnionMember[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((member, index) => {
        const other = right[index];
        return other !== undefined
            && member.machineId === other.machineId
            && member.serverId === other.serverId
            && member.projection === other.projection
            && member.phase === other.phase
            && member.interactionEnabled === other.interactionEnabled;
    });
}

/**
 * Project selected app-scope contributions into ONE model.
 *
 * A plugin's placement, hosted-web/React Native contribution, translations and
 * artifacts all follow the SAME Administration decision: the exact per-plugin
 * materialization when one exists, otherwise the Plugin machine target. This
 * function has no winner election; replicated originless contributions stay
 * withheld until that machine target is available.
 */
export function unionPluginUiProjections(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
    selectedOriginlessMachineId: string | null = null,
): PluginUiProjectionUnion {
    const eligible = members.filter((member) => readString(member.machineId) !== null);
    const phase = resolveUnionProjectionPhase(eligible);
    const soleMember = eligible.length === 1 ? eligible[0] : undefined;
    const contributing = [...eligible]
        .filter((member): member is PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }> => (
            member.projection !== null
        ))
        // Deterministic and presence-free: machine id, never `activeAt`.
        .sort((left, right) => left.machineId.localeCompare(right.machineId));

    if (contributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: null,
            phase,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const originlessMembersByPluginId = new Map<string, Set<string>>();
    for (const member of contributing) {
        const model = member.projection;
        const entries = [
            ...Object.values(model.translationsByPluginId),
            ...Object.values(model.sessionHeaderActionsById),
            ...Object.values(model.searchProvidersById),
            ...Object.values(model.hostedWebById),
            ...Object.values(model.reactNativeBundlesById),
            ...Object.values(model.surfacePlacementsById),
            ...Object.values(model.settingsGroupsById),
            ...Object.values(model.settingsPagesById),
            ...Object.values(model.actionsById),
            ...Object.values(model.voiceProvidersById),
            ...Object.values(model.dragSourcesById),
            ...Object.values(model.dropTargetsById),
            ...Object.values(model.inputTypesById),
            ...Object.values(model.unknownEntriesById),
        ];
        for (const entry of entries) {
            const pluginId = readString(asRecord(entry)?.pluginId);
            if (
                !pluginId
                || selectedOriginsByPluginId.has(pluginId)
                || readPluginUiProjectionEntryExecutionOrigin(entry) !== null
            ) continue;
            const memberKey = `${member.serverId ?? ''}\u0000${member.machineId}`;
            const owners = originlessMembersByPluginId.get(pluginId) ?? new Set<string>();
            owners.add(memberKey);
            originlessMembersByPluginId.set(pluginId, owners);
        }
    }
    const conflictedOriginlessPluginIds = new Set(
        [...originlessMembersByPluginId]
            .filter(([, owners]) => owners.size > 1)
            .map(([pluginId]) => pluginId),
    );

    const admittedContributing = contributing.filter((member) => memberHasAdmittedContribution({
        member,
        selectedOriginsByPluginId,
        selectedOriginlessMachineId,
        conflictedOriginlessPluginIds,
    }));

    if (admittedContributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: null,
            phase,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    // The aggregate has no exact contribution in hand. It is executable only
    // when its own catalog phase is current and at least one selected source is
    // itself current. Concrete mounts use their per-entry origin below, so this
    // coarse fail-closed flag cannot revoke an unrelated current origin.
    const interactionEnabled = phase === 'current'
        && admittedContributing.some((member) => (
            member.phase === 'current' && member.interactionEnabled
        ));

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const installedPackagesById: Record<string, PluginProjectionInstalledPackageV2> = {};
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const searchProvidersById: Record<string, PluginUiSearchProviderProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiPhysicalSurfacePlacementProjection> = {};
    const settingsGroupsById: Record<string, PluginUiSettingsGroupProjection> = {};
    const settingsPagesById: Record<string, PluginUiSettingsPageProjection> = {};
    const actionsById: Record<string, PluginUiActionProjection> = {};
    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const dragSourcesById: Record<string, PluginUiDragSourceProjection> = {};
    const dropTargetsById: Record<string, PluginUiDropTargetProjection> = {};
    const resourcesById: Record<string, PluginUiResourceProjection> = {};
    const inputTypesById: Record<string, PluginUiInputTypeProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};

    // Exact selected origins are unique. Originless replicas admit only the
    // selected machine (or the sole fallback before a selection exists), so
    // this guard only protects malformed duplicate keys within one producer.
    const publishFirstAdmitted = <T>(map: Record<string, T>, key: string, value: T): void => {
        if (Object.hasOwn(map, key)) return;
        map[key] = value;
    };

    for (const member of admittedContributing) {
        const model = member.projection;
        const admittedPluginIds = new Set<string>();
        const admittedOriginsByPluginId = new Map<string, PluginUiContributionOriginV1>();
        const originFor = (entry: UnknownRecord): PluginUiContributionOriginV1 | null => {
            const admission = admitMemberEntry({
                member,
                selectedOriginsByPluginId,
                selectedOriginlessMachineId,
                conflictedOriginlessPluginIds,
                entry,
            });
            if (!admission) return null;
            const executionOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
            // A selected contribution keeps its hard producer-stamp
            // requirement. An originless contribution has no
            // materialization to stamp, so it publishes an absent exact origin:
            // every consumer that needs one still fails closed on its own
            // rather than on a fabricated identity.
            if (!executionOrigin && admission !== 'originless') return null;
            const pluginId = executionOrigin?.materializationRef.pluginId
                ?? readString(entry.pluginId);
            if (pluginId) admittedPluginIds.add(pluginId);
            const origin: PluginUiContributionOriginV1 = Object.freeze({
                machineId: member.machineId,
                serverId: member.serverId,
                generation: model.generation,
                interactionEnabled: member.interactionEnabled,
                phase: member.phase,
                executionOrigin,
            });
            if (pluginId) admittedOriginsByPluginId.set(pluginId, origin);
            return origin;
        };

        for (const [pluginId, entry] of Object.entries(model.translationsByPluginId)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(translationsByPluginId, pluginId, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.sessionHeaderActionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(sessionHeaderActionsById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.searchProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(searchProvidersById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.hostedWebById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(hostedWebById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.reactNativeBundlesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(reactNativeBundlesById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.surfacePlacementsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(surfacePlacementsById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.settingsGroupsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(settingsGroupsById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.settingsPagesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(settingsPagesById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.actionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(actionsById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.voiceProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(voiceProvidersById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.dragSourcesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(dragSourcesById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.dropTargetsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(dropTargetsById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.unknownEntriesById)) {
            const origin = originFor(entry);
            if (origin) {
                publishFirstAdmitted(unknownEntriesById, id, stamp(entry, origin));
            }
        }
        for (const [id, entry] of Object.entries(model.resourcesById)) {
            const hasProducerStamp = entry.serverIdentityId !== undefined || entry.materializationRef !== undefined;
            const origin = hasProducerStamp
                ? resourceHasCurrentProducerOrigin(model, entry) ? originFor(entry) : null
                // Earlier rows are only contextual facts of an admitted UI
                // contribution, never independent app-scope read authority.
                : admittedOriginsByPluginId.get(entry.pluginId);
            if (origin) publishFirstAdmitted(resourcesById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.inputTypesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                ? originFor(entry)
                : null;
            if (origin) publishFirstAdmitted(inputTypesById, id, stamp(entry, origin));
        }
        // A package catalog fact has no contribution-level origin stamp of its
        // own. It is therefore visible in an app union only after one of that
        // same plugin's actual contributions was admitted for this member —
        // by the exact selected materialization, or as an unmaterialized
        // contribution. This prevents a newer replica's brand from shadowing
        // the selected artifact's brand.
        for (const pluginId of admittedPluginIds) {
            const installedPackage = model.installedPackagesById[pluginId];
            if (installedPackage) {
                publishFirstAdmitted(installedPackagesById, pluginId, installedPackage);
            }
        }
    }

    const generations = admittedContributing.map((member) => member.projection.generation);
    const generation = generations.every((memberGeneration) => memberGeneration === null)
        ? null
        : admittedContributing.length === 1
            ? generations[0]!
            : deriveUnionGeneration(admittedContributing);
    const entryCount = Object.keys(translationsByPluginId).length
        + Object.keys(sessionHeaderActionsById).length
        + Object.keys(searchProvidersById).length
        + Object.keys(hostedWebById).length
        + Object.keys(reactNativeBundlesById).length
        + Object.keys(surfacePlacementsById).length
        + Object.keys(settingsGroupsById).length
        + Object.keys(settingsPagesById).length
        + Object.keys(actionsById).length
        + Object.keys(voiceProvidersById).length
        + Object.keys(dragSourcesById).length
        + Object.keys(dropTargetsById).length
        + Object.keys(resourcesById).length
        + Object.keys(inputTypesById).length
        + Object.keys(unknownEntriesById).length;

    if (generation === null && entryCount === 0) {
        // Every member is still an ungeneration-ed empty snapshot, which is what
        // the canonical empty model already IS. Returning the shared instance
        // keeps a loading union from reading as a projection REPLACEMENT and
        // needlessly invalidating the React Native runtime.
        return Object.freeze({
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
            phase,
            interactionEnabled,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const pluginUiProjection: PluginUiProjectionModel = Object.freeze({
        generation,
        installedPackagesById: Object.freeze(installedPackagesById),
        // Composer contribution families remain scoped to their Session host.
        // An App union must carry the model's complete shape without becoming a
        // second Composer catalog/selection authority.
        composerAttachmentsById: Object.freeze({}),
        composerControlsById: Object.freeze({}),
        composerRegionsById: Object.freeze({}),
        translationsByPluginId: Object.freeze(translationsByPluginId),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        searchProvidersById: Object.freeze(searchProvidersById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        settingsGroupsById: Object.freeze(settingsGroupsById),
        settingsPagesById: Object.freeze(settingsPagesById),
        actionsById: Object.freeze(actionsById),
        voiceProvidersById: Object.freeze(voiceProvidersById),
        dragSourcesById: Object.freeze(dragSourcesById),
        dropTargetsById: Object.freeze(dropTargetsById),
        resourcesById: Object.freeze(resourcesById),
        inputTypesById: Object.freeze(inputTypesById),
        // Openable viewers are scoped to a session/project details host. There is
        // no app-union consumer, so do not make app scope a second projection
        // owner for them.
        openableContentViewersById: Object.freeze({}),
        unknownEntriesById: Object.freeze(unknownEntriesById),
        transcriptActivitiesById: Object.freeze({}),
        sessionInfoSectionsById: Object.freeze({}),
    });

    return Object.freeze({
        pluginUiProjection,
        phase,
        interactionEnabled,
        machineId: soleMember?.machineId ?? null,
        serverId: soleMember?.serverId ?? null,
    });
}

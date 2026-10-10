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
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginSourceCustodyV1Schema, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginDeclarativeProjectedModelV1Schema, projectPluginDeclarativeModelComparisonV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import type { PluginUiProjectionPhase } from './usePluginUiProjectionCurrentness';
import { composePluginMachineExecutionOriginV1, type PluginMachineSourceExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';

type UnknownRecord = Readonly<Record<string, unknown>>;

/** Account declaration visibility precedes per-plugin execution selection. */
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
    serverIdentityId?: string;
    projection: PluginUiProjectionModel | null;
    phase: PluginUiProjectionPhase;
    interactionEnabled: boolean;
    /** Exact reported content correspondence, separate from runtime authority. */
    materializationsByPluginId?: Readonly<Record<string, PluginMachineMaterializationV1>>;
}>;

export type PluginUiContributionSupplyV1 = PluginUiContributionOriginV1 & Readonly<{
    occurrenceId: string | null;
    pluginVersion: string | null;
    sourceCustody: PluginSourceCustodyV1 | null;
    executionTargetDefault: boolean;
}>;

export function mergeInstalledPluginUiProjections(
    installed: readonly PluginUiProjectionModel[],
    runtime: PluginUiProjectionModel | null,
): PluginUiProjectionModel | null {
    if (installed.length === 0) return runtime;
    const installedPluginIds = new Set(installed.flatMap(model => declarationMaps(model).flatMap(map =>
        Object.values(map).flatMap(entry => { const id = readString(asRecord(entry)?.pluginId); return id ? [id] : []; }))));
    const merge = <T>(read: (model: PluginUiProjectionModel) => Readonly<Record<string, T>>) => {
        const declared: Record<string, T> = Object.assign({}, ...installed.map(read));
        for (const [key, entry] of Object.entries(runtime ? read(runtime) : {})) {
            const pluginId = readString(asRecord(entry)?.pluginId);
            if (!pluginId || !installedPluginIds.has(pluginId)
                || (declared[key] && stableContent(declarationContent(declared[key])) === stableContent(declarationContent(entry)))) {
                declared[key] = entry;
            }
        }
        return Object.freeze(declared);
    };
    return Object.freeze({
        ...(runtime ?? EMPTY_PLUGIN_UI_PROJECTION),
        generation: runtime?.generation ?? null,
        installedPackagesById: Object.freeze(Object.assign({}, ...installed.map(model => model.installedPackagesById), runtime?.installedPackagesById)),
        translationsByPluginId: merge(model => model.translationsByPluginId),
        sessionHeaderActionsById: merge(model => model.sessionHeaderActionsById),
        searchProvidersById: merge(model => model.searchProvidersById),
        hostedWebById: merge(model => model.hostedWebById),
        reactNativeBundlesById: merge(model => model.reactNativeBundlesById),
        surfacePlacementsById: merge(model => model.surfacePlacementsById),
        settingsGroupsById: merge(model => model.settingsGroupsById),
        settingsPagesById: merge(model => model.settingsPagesById),
        voiceProvidersById: merge(model => model.voiceProvidersById),
        unknownEntriesById: merge(model => model.unknownEntriesById),
    });
}

/**
 * The canonical Administration decision for each plugin that may contribute to
 * the app scope. Selection binds effects only; its absence cannot remove
 * an installed declaration from the Account catalog.
 */
export type PluginUiProjectionUnionOriginSelections = ReadonlyMap<
    string,
    PluginMachineExecutionOriginV1
>;

export type PluginUiProjectionUnion = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    /** Canonical state for app consumers without a contribution-specific origin. */
    phase: PluginUiProjectionPhase;
    /** Missing destinations remain unresolved while an eligible origin is pending. */
    hasEstablishingMembers: boolean;
    /**
     * Coarse roll-up across current contributors. The per-contribution
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
    hasEstablishingMembers: false,
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
    // Current presentation is not withheld by an unrelated pending origin.
    // Catalog completeness is published separately for missing destinations;
    // executable authority remains stamped on each exact contribution below.
    if (members.some((member) => member.phase === 'current')) return 'current';
    if (members.some((member) => member.phase === 'establishing')) return 'establishing';
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
    const executionOrigin = origin.executionOrigin == null
        ? null
        : PluginMachineExecutionOriginV1Schema.safeParse(origin.executionOrigin);
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
        executionOrigin: executionOrigin?.success ? executionOrigin.data : null,
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
    if (!candidate || !pluginId || candidate.serverIdentityId == null || candidate.materializationRef == null) return null;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: candidate.serverIdentityId,
        materializationRef: candidate.materializationRef,
    });
    if (!parsed.success || !('materializationRef' in parsed.data) || parsed.data.materializationRef.pluginId !== pluginId) return null;
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
        && 'materializationRef' in selectedOrigin
        && 'materializationRef' in producerOrigin
        && selectedOrigin.materializationRef.pluginId === pluginId
        && selectedOrigin.materializationRef.machineId === input.machineId
        && producerOrigin.materializationRef.machineId === input.machineId
        && arePluginMachineExecutionOriginsEqual(selectedOrigin, producerOrigin);
}

function memberHasAdmittedContribution(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
): boolean {
    return declarationMaps(member.projection).some(map => Object.values(map).some(entry => readString(asRecord(entry)?.pluginId) !== null))
        || Object.values(member.projection.resourcesById).some(entry => resourceHasCurrentProducerOrigin(member.projection, entry)
            && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
        || Object.values(member.projection.inputTypesById).some(entry => entryHasCurrentOccurrence(member.projection, entry)
            && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId })));
}

function declarationMaps(model: PluginUiProjectionModel): readonly Readonly<Record<string, unknown>>[] {
    return [model.translationsByPluginId, model.sessionHeaderActionsById, model.searchProvidersById,
        model.hostedWebById, model.reactNativeBundlesById, model.surfacePlacementsById,
        model.settingsGroupsById, model.settingsPagesById, model.actionsById, model.voiceProvidersById,
        model.dragSourcesById, model.dropTargetsById, model.unknownEntriesById];
}

/** Runtime identity and health are not portable declaration content. */
function declarationContent(entry: unknown): unknown {
    const record = asRecord(entry);
    if (!record) return entry;
    const { occurrenceId, serverIdentityId, materializationRef, sourceCustody, immutableGenerationId, generation,
        enabled, availability, available, runtimeMode, runtimeDiagnostics, diagnostics, ...content } = record;
    const renderer = asRecord(content.renderer);
    if (renderer?.kind !== 'declarative' || renderer.model === undefined) return content;
    const model = PluginDeclarativeProjectedModelV1Schema.safeParse(renderer.model);
    return model.success ? { ...content, renderer: { ...renderer, model: projectPluginDeclarativeModelComparisonV1(model.data) } } : content;
}

function stableContent(value: unknown): string {
    return JSON.stringify(value, (_key, child: unknown) => {
        const record = asRecord(child);
        return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])) : child;
    });
}

function pluginDeclarationContent(member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>, pluginId: string): string {
    const model = member.projection;
    const installed = model.installedPackagesById[pluginId];
    const materialization = member.materializationsByPluginId?.[pluginId];
    const stamped = declarationMaps(model).some(map => Object.values(map)
        .some(entry => asRecord(entry)?.pluginId === pluginId && readPluginUiProjectionEntryExecutionOrigin(entry) !== null));
    const contentCorrespondence = materialization?.portableRelease && materialization.archiveDigestSha256
        ? [materialization.archiveDigestSha256, [...materialization.uiArtifacts].sort((left, right) => stableContent(left).localeCompare(stableContent(right)))]
        : materialization && !materialization.portableRelease ? [materialization.declaredManifest,
            [...materialization.uiArtifacts].sort((left, right) => stableContent(left).localeCompare(stableContent(right)))]
        : stamped ? ['unprovenPortableContent', member.serverId, member.machineId] : null;
    return stableContent([
        contentCorrespondence,
        installed ? [installed.id, installed.displayName, installed.version, installed.executionTarget] : null,
        ...declarationMaps(model).map(map => Object.entries(map)
            .filter(([, entry]) => asRecord(entry)?.pluginId === pluginId)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, declarationContent(entry)])),
        Object.entries(model.resourcesById).filter(([, entry]) => entry.pluginId === pluginId)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, declarationContent(entry)]),
    ]);
}

export function readPluginUiContributionSupplies(entry: unknown): readonly PluginUiContributionSupplyV1[] {
    const supplies = asRecord(entry)?.hostSupplies;
    return Array.isArray(supplies) ? supplies.flatMap(supply => {
        const origin = readPluginUiContributionOrigin({ hostOrigin: supply });
        if (!origin) return [];
        const facts = asRecord(supply);
        const custody = facts?.sourceCustody == null ? null : PluginSourceCustodyV1Schema.safeParse(facts.sourceCustody);
        return [{ ...origin, occurrenceId: readString(facts?.occurrenceId), pluginVersion: readString(facts?.pluginVersion),
            sourceCustody: custody?.success ? custody.data : null,
            executionTargetDefault: facts?.executionTargetDefault === true }];
    }) : [];
}

/** Project exact reported supplies into Administration; never elect an origin here. */
export function readPluginUiExecutionOriginCandidates(params: Readonly<{
    projection: PluginUiProjectionModel | null;
    pluginId: string;
    entry?: unknown;
}>): Readonly<{
    sourceCandidates: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins: readonly PluginMachineExecutionOriginV1[];
}> {
    const entries = params.entry ? [params.entry] : params.projection
        ? declarationMaps(params.projection).flatMap(map => Object.values(map).filter(entry => asRecord(entry)?.pluginId === params.pluginId)) : [];
    const sourceCandidates: PluginMachineSourceExecutionOriginCandidateV1[] = [];
    const declaredDefaultOrigins: PluginMachineExecutionOriginV1[] = [];
    for (const entry of entries) {
        const conflict = asRecord(entry)?.hostCompatibility === 'conflict';
        for (const supply of readPluginUiContributionSupplies(entry)) {
            const origin = supply.executionOrigin;
            if (!origin || getPluginMachineExecutionOriginRef(origin).pluginId !== params.pluginId) continue;
            if (supply.executionTargetDefault && !conflict
                && !declaredDefaultOrigins.some(candidate => arePluginMachineExecutionOriginsEqual(candidate, origin))) declaredDefaultOrigins.push(origin);
            if (!('sourceRef' in origin) || !supply.occurrenceId || !supply.pluginVersion
                || !supply.serverId || supply.generation === null
                || sourceCandidates.some(candidate => arePluginMachineExecutionOriginsEqual(candidate.source.origin, origin))) continue;
            sourceCandidates.push(Object.freeze({
                source: Object.freeze({ origin, version: supply.pluginVersion, occurrenceId: supply.occurrenceId,
                    serverId: supply.serverId, generation: supply.generation }),
                releaseContent: conflict ? 'conflict' : 'matched',
                validation: conflict ? { kind: 'rejected', reason: 'content_conflict' }
                    : supply.phase === 'current' && supply.interactionEnabled ? { kind: 'admitted' }
                        : { kind: 'rejected', reason: 'stale' },
            }));
        }
    }
    return Object.freeze({ sourceCandidates: Object.freeze(sourceCandidates), declaredDefaultOrigins: Object.freeze(declaredDefaultOrigins) });
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
            && member.serverIdentityId === other.serverIdentityId
            && member.projection === other.projection
            && member.materializationsByPluginId === other.materializationsByPluginId
            && member.phase === other.phase
            && member.interactionEnabled === other.interactionEnabled;
    });
}

/** Derive one descriptive Account catalog; exact effects remain origin-bound. */
export function unionPluginUiProjections(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections = new Map(),
): PluginUiProjectionUnion {
    const eligible = members.filter((member) => readString(member.machineId) !== null);
    const phase = resolveUnionProjectionPhase(eligible);
    const hasEstablishingMembers = eligible.some((member) => member.phase === 'establishing');
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
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const admittedContributing = contributing.filter(member => memberHasAdmittedContribution(member, selectedOriginsByPluginId));
    const suppliesByPluginId = new Map<string, (typeof contributing)[number][]>();
    for (const member of admittedContributing) {
        const pluginIds = new Set(declarationMaps(member.projection).flatMap(map => Object.values(map)
            .flatMap(entry => { const id = readString(asRecord(entry)?.pluginId); return id ? [id] : []; })));
        for (const pluginId of pluginIds) {
            const supplies = suppliesByPluginId.get(pluginId) ?? [];
            supplies.push(member);
            suppliesByPluginId.set(pluginId, supplies);
        }
    }
    const conflictedPluginIds = new Set([...suppliesByPluginId].flatMap(([pluginId, supplies]) => (
        new Set(supplies.map(member => pluginDeclarationContent(member, pluginId))).size > 1 ? [pluginId] : []
    )));

    if (admittedContributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: null,
            phase,
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    // The aggregate has no exact contribution in hand. It is executable only
    // when its own catalog phase is current and at least one supplying source is
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

    // Aggregate equivalent declarations without appointing a producer. Exact
    // source facts are retained separately, including offline supplying copies.
    const publishFirstAdmitted = <T>(map: Record<string, T>, key: string, value: T): void => {
        const entry = asRecord(value);
        const pluginId = readString(entry?.pluginId);
        if (!entry || !pluginId) return;
        const origin = readPluginUiContributionOrigin(entry);
        if (!origin) return;
        const previous = asRecord(map[key]);
        const sourceCustody = contributing.find(member => member.machineId === origin.machineId && member.serverId === origin.serverId)
            ?.projection.installedPackagesById[pluginId]?.sourceCustody ?? null;
        const installed = contributing.find(member => member.machineId === origin.machineId && member.serverId === origin.serverId)
            ?.projection.installedPackagesById[pluginId];
        const supply: PluginUiContributionSupplyV1 = Object.freeze({ ...origin, occurrenceId: readString(entry.occurrenceId),
            pluginVersion: installed?.version ?? null, sourceCustody,
            executionTargetDefault: installed?.executionTarget?.default === 'installation' });
        const supplies = Object.freeze([...readPluginUiContributionSupplies(previous), supply]);
        const conflict = conflictedPluginIds.has(pluginId);
        const selected = selectedOriginsByPluginId.get(pluginId);
        const binding = conflict ? null : selected
            ? supplies.find(supply => supply.executionOrigin && arePluginMachineExecutionOriginsEqual(selected, supply.executionOrigin)) ?? null
            : supplies.length === 1 ? supplies[0]! : null;
        const representative = binding === supply || !previous ? entry : previous;
        const availability = asRecord(representative.availability);
        map[key] = Object.freeze({
            ...representative,
            // A descriptive row may not carry the first replica's runtime
            // identity into a consumer that reads the direct producer stamp.
            ...(!binding ? { occurrenceId: undefined, serverIdentityId: undefined, materializationRef: undefined } : {}),
            hostOrigin: binding,
            hostSupplies: supplies,
            hostCompatibility: conflict ? 'conflict' : 'compatible',
            ...(conflict && availability ? { availability: Object.freeze({ ...availability, state: 'blocked', reason: 'installationConflict' }) } : {}),
        }) as T;
    };

    for (const member of admittedContributing) {
        const model = member.projection;
        const admittedPluginIds = new Set<string>();
        const admittedOriginsByPluginId = new Map<string, PluginUiContributionOriginV1>();
        const sourceOriginsByPluginId = new Map<string, PluginMachineExecutionOriginV1 | null>();
        const originFor = (entry: UnknownRecord): PluginUiContributionOriginV1 | null => {
            let executionOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
            if (!readString(entry.pluginId)) return null;
            const pluginId = readString(entry.pluginId);
            const installedPackage = pluginId ? model.installedPackagesById[pluginId] : undefined;
            const observedInstallation = pluginId ? member.materializationsByPluginId?.[pluginId] : undefined;
            if (!executionOrigin && readString(entry.occurrenceId) === null && observedInstallation?.portableRelease) {
                // This is the report's real installation coordinate, not a
                // runtime occurrence or an inferred source identity.
                executionOrigin = composePluginMachineExecutionOriginV1(observedInstallation);
            }
            if (!executionOrigin && pluginId && installedPackage?.sourceCustody && entryHasCurrentOccurrence(model, { pluginId, occurrenceId: readString(entry.occurrenceId) ?? undefined })) {
                if (!sourceOriginsByPluginId.has(pluginId)) {
                    const source = PluginMachineExecutionOriginV1Schema.safeParse({ serverIdentityId: member.serverIdentityId,
                        sourceRef: { machineId: member.machineId, pluginId, sourceCustody: installedPackage.sourceCustody } });
                    sourceOriginsByPluginId.set(pluginId, source.success ? source.data : null);
                }
                executionOrigin = sourceOriginsByPluginId.get(pluginId) ?? null;
            }
            if (pluginId) admittedPluginIds.add(pluginId);
            const origin: PluginUiContributionOriginV1 = Object.freeze({
                machineId: member.machineId,
                serverId: member.serverId,
                generation: model.generation,
                interactionEnabled: member.interactionEnabled && model.generation !== null
                    && (!observedInstallation || (observedInstallation.enabled && observedInstallation.trustState === 'trusted'))
                    && (readString(entry.occurrenceId) !== null || readPluginUiProjectionEntryExecutionOrigin(entry) !== null),
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
                ? resourceHasCurrentProducerOrigin(model, entry)
                    && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }) ? originFor(entry) : null
                // Earlier rows are only contextual facts of an admitted UI
                // contribution, never independent app-scope read authority.
                : admittedOriginsByPluginId.get(entry.pluginId);
            if (origin) publishFirstAdmitted(resourcesById, id, stamp(entry, origin));
        }
        for (const [id, entry] of Object.entries(model.inputTypesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                    || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
                ? originFor(entry)
                : null;
            if (origin) publishFirstAdmitted(inputTypesById, id, stamp(entry, origin));
        }
        // A package catalog fact has no contribution-level origin stamp of its
        // own. It is therefore visible in an app union only after one of that
        // same plugin's actual declarations were observed for this member —
        // by an exact installation or as an unmaterialized
        // contribution. This prevents a newer replica's brand from shadowing
        // the selected artifact's brand.
        for (const pluginId of admittedPluginIds) {
            const installedPackage = model.installedPackagesById[pluginId];
            if (installedPackage) {
                if (!installedPackagesById[pluginId]) installedPackagesById[pluginId] = conflictedPluginIds.has(pluginId)
                    ? Object.freeze({ ...installedPackage, enabled: false, occurrenceId: undefined, sourceCustody: undefined, brand: undefined })
                    : installedPackage;
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
            hasEstablishingMembers,
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
        hasEstablishingMembers,
        interactionEnabled,
        machineId: soleMember?.machineId ?? null,
        serverId: soleMember?.serverId ?? null,
    });
}

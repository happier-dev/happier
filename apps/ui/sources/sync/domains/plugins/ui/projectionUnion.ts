import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiActionProjection,
    type PluginUiHostedWebProjection,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
    type PluginUiSessionHeaderActionProjection,
    type PluginUiStructuredMessageProjection,
    type PluginUiPhysicalSurfacePlacementProjection,
    type PluginUiTranslationsProjection,
    type PluginVoiceProviderProjection,
} from './projection';
import {
    arePluginMachineExecutionOriginsEqual,
    PluginMachineExecutionOriginV1Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionInstalledPackageV2,
} from '@happier-dev/protocol';
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
 * zero, one, or an explicitly selected exact materialization. This projection
 * consumes that result and only then retains a matching member's contribution.
 * It stamps each retained contribution with that origin machine, generation and
 * interaction authority, so a mount cannot roam because a heartbeat changed.
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
 * not. The two arms are not interchangeable: only an UNMATERIALIZED
 * contribution may be published without an exact producer stamp.
 */
type PluginUiProjectionUnionEntryAdmission = 'unmaterialized' | 'selectedOrigin';

function admitMemberEntry(input: Readonly<{
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>;
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    entry: unknown;
}>): PluginUiProjectionUnionEntryAdmission | null {
    const pluginId = readString(asRecord(input.entry)?.pluginId);
    if (!pluginId) return null;
    // The unmaterialized arm.
    //
    // The projection producer stamps an entry only for a plugin it holds a
    // materialization for (`materializationIdsByPluginId`). A plugin the
    // Account can never materialize therefore arrives UNSTAMPED and has
    // nothing for Administration to select: requiring a selected origin for it
    // is not fail-closed, it is fail-always — it removed every app-scope
    // contribution of every such plugin, on every machine.
    //
    // The discriminator is that STRUCTURAL fact — the producer stamped no
    // materialization — never the plugin's provenance. A plugin shipped inside
    // the host binary and an externally authored plugin the daemon loaded
    // without an Account materialization are in the identical position and are
    // admitted on identical terms. Wherever an Administration selection CAN
    // exist it stays the sole authority, so this arm fills only the gap a
    // selection can never reach and can never shadow a selected
    // materialization.
    if (
        !input.selectedOriginsByPluginId.has(pluginId)
        && readPluginUiProjectionEntryExecutionOrigin(input.entry) === null
    ) {
        return 'unmaterialized';
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
}>): boolean {
    const owns = (entry: unknown): boolean => admitMemberEntry({
        member: input.member,
        selectedOriginsByPluginId: input.selectedOriginsByPluginId,
        entry,
    }) !== null;
    const projection = input.member.projection;
    return Object.values(projection.translationsByPluginId).some(owns)
        || Object.values(projection.structuredMessagesByKind).some(owns)
        || Object.values(projection.sessionHeaderActionsById).some(owns)
        || Object.values(projection.hostedWebById).some(owns)
        || Object.values(projection.reactNativeBundlesById).some(owns)
        || Object.values(projection.surfacePlacementsById).some(owns)
        || Object.values(projection.settingsGroupsById).some(owns)
        || Object.values(projection.settingsPagesById).some(owns)
        || Object.values(projection.actionsById).some(owns)
        || Object.values(projection.voiceProvidersById).some(owns)
        || Object.values(projection.unknownEntriesById).some(owns);
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
 * artifacts all follow the SAME Administration-selected materialization. The
 * caller must supply that decision for every visible plugin. This function has
 * no winner election and intentionally treats a missing or malformed selection
 * as no contribution.
 */
export function unionPluginUiProjections(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
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

    const admittedContributing = contributing.filter((member) => memberHasAdmittedContribution({
        member,
        selectedOriginsByPluginId,
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
    const structuredMessagesByKind: Record<string, PluginUiStructuredMessageProjection> = {};
    const ambiguousStructuredMessageKinds = new Set<string>();
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiPhysicalSurfacePlacementProjection> = {};
    const settingsGroupsById: Record<string, PluginUiSettingsGroupProjection> = {};
    const settingsPagesById: Record<string, PluginUiSettingsPageProjection> = {};
    const actionsById: Record<string, PluginUiActionProjection> = {};
    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};

    // A plugin the Account can never materialize is admitted through the
    // unmaterialized arm on EVERY machine that holds it, so the same
    // contribution key arrives once per member. `admittedContributing` is
    // already ordered by `machineId`, which makes the first admitted replica
    // the deterministic one; plain assignment instead published the last, so
    // connecting an unrelated machine silently re-homed every such surface and
    // shadowed its package brand. A replica is therefore skipped. The selected
    // arm cannot produce a duplicate at all — it admits only the one member
    // whose `machineId` equals the selection's — so this changes nothing there.
    const publishFirstAdmitted = <T>(map: Record<string, T>, key: string, value: T): void => {
        if (Object.hasOwn(map, key)) return;
        map[key] = value;
    };

    for (const member of admittedContributing) {
        const model = member.projection;
        const admittedPluginIds = new Set<string>();
        const originFor = (entry: UnknownRecord): PluginUiContributionOriginV1 | null => {
            const admission = admitMemberEntry({ member, selectedOriginsByPluginId, entry });
            if (!admission) return null;
            const executionOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
            // A selected contribution keeps its hard producer-stamp
            // requirement. An unmaterialized contribution has no
            // materialization to stamp, so it publishes an absent exact origin:
            // every consumer that needs one still fails closed on its own
            // rather than on a fabricated identity.
            if (!executionOrigin && admission !== 'unmaterialized') return null;
            const pluginId = executionOrigin?.materializationRef.pluginId
                ?? readString(entry.pluginId);
            if (pluginId) admittedPluginIds.add(pluginId);
            return Object.freeze({
                machineId: member.machineId,
                serverId: member.serverId,
                generation: model.generation,
                interactionEnabled: member.interactionEnabled,
                phase: member.phase,
                executionOrigin,
            });
        };

        for (const [pluginId, entry] of Object.entries(model.translationsByPluginId)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(translationsByPluginId, pluginId, stamp(entry, origin));
        }
        for (const [kind, entry] of Object.entries(model.structuredMessagesByKind)) {
            const origin = originFor(entry);
            if (!origin || ambiguousStructuredMessageKinds.has(kind)) continue;
            const published = structuredMessagesByKind[kind];
            if (published !== undefined) {
                // Another machine's copy of the SAME plugin's descriptor is a
                // replica, not a competing claim: dropping the kind there would
                // erase the renderer as soon as a second machine connected.
                if (published.pluginId === entry.pluginId) continue;
                // Two plugins claiming one transcript kind is ambiguous, exactly
                // as it is inside a single machine's normalization.
                delete structuredMessagesByKind[kind];
                ambiguousStructuredMessageKinds.add(kind);
                continue;
            }
            structuredMessagesByKind[kind] = stamp(entry, origin);
        }
        for (const [id, entry] of Object.entries(model.sessionHeaderActionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(sessionHeaderActionsById, id, stamp(entry, origin));
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
        for (const [id, entry] of Object.entries(model.unknownEntriesById)) {
            const origin = originFor(entry);
            if (origin) {
                publishFirstAdmitted(unknownEntriesById, id, stamp(entry, origin));
            }
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
        + Object.keys(structuredMessagesByKind).length
        + Object.keys(sessionHeaderActionsById).length
        + Object.keys(hostedWebById).length
        + Object.keys(reactNativeBundlesById).length
        + Object.keys(surfacePlacementsById).length
        + Object.keys(settingsGroupsById).length
        + Object.keys(settingsPagesById).length
        + Object.keys(actionsById).length
        + Object.keys(voiceProvidersById).length
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
        structuredMessagesByKind: Object.freeze(structuredMessagesByKind),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        settingsGroupsById: Object.freeze(settingsGroupsById),
        settingsPagesById: Object.freeze(settingsPagesById),
        actionsById: Object.freeze(actionsById),
        voiceProvidersById: Object.freeze(voiceProvidersById),
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

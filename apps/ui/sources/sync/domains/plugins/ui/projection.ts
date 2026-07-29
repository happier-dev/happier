import type {
    DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import {
    PluginSessionHeaderActionDescriptorV1Schema,
    PluginVoiceProviderContributionV1Schema,
    RecipientContractV1Schema,
    buildQualifiedPluginContributionKey,
    createRecipientContractDigestV1,
    createPluginContributionIdentity,
    type PluginLocalizedStringV2,
    type PluginSessionHeaderActionDescriptorV1,
    type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';

import {
    addStructuredMessageToKindMap,
    isStructuredMessage,
    type PluginUiStructuredMessageProjection,
} from './structuredMessages';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type { PluginUiStructuredMessageProjection };

export type PluginUiTranslationsProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'translations';
    locales: readonly string[];
}>;

export type PluginUiSessionHeaderActionProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'sessionHeaderAction';
    descriptorId: string;
    title: PluginSessionHeaderActionDescriptorV1['title'];
    action: PluginSessionHeaderActionDescriptorV1['action'];
    qualifiedActionId: string;
}>;

export type PluginUiHostedWebProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'hostedWeb';
    contributionId: string;
}>;

export type PluginUiReactNativeBundleProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'reactNativeBundle';
    contributionId: string;
}>;

export type PluginUiSurfaceAvailabilityProjection = Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}>;

export type PluginUiSurfacePlacementProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'surfacePlacement';
    descriptorId: string;
    placement: string;
    target: UnknownRecord;
    renderer: UnknownRecord;
    display: UnknownRecord;
    availability: PluginUiSurfaceAvailabilityProjection;
    rightSidebar?: UnknownRecord;
    order?: number;
}>;

export type PluginUiArtifactProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'uiArtifact';
    artifactId: string;
}>;

export type PluginUiDigestProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'digest';
    digest: string;
    families?: UnknownRecord;
}>;

export type PluginVoiceProviderProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    generation: number;
    contributionKey: string;
    definition: PluginVoiceProviderContributionV1;
    recipientContract?: import('@happier-dev/protocol').RecipientContractV1;
    recipientContractDigest?: string;
}>;

export type PluginUiProjectionModel = Readonly<{
    generation: number | null;
    translationsByPluginId: Readonly<Record<string, PluginUiTranslationsProjection>>;
    structuredMessagesByKind: Readonly<Record<string, PluginUiStructuredMessageProjection>>;
    sessionHeaderActionsById: Readonly<Record<string, PluginUiSessionHeaderActionProjection>>;
    hostedWebById: Readonly<Record<string, PluginUiHostedWebProjection>>;
    reactNativeBundlesById: Readonly<Record<string, PluginUiReactNativeBundleProjection>>;
    surfacePlacementsById: Readonly<Record<string, PluginUiSurfacePlacementProjection>>;
    surfacePlacementsByPlacement: Readonly<Record<string, readonly PluginUiSurfacePlacementProjection[]>>;
    uiArtifactsById: Readonly<Record<string, PluginUiArtifactProjection>>;
    digestsByPluginId: Readonly<Record<string, PluginUiDigestProjection>>;
    voiceProvidersById: Readonly<Record<string, PluginVoiceProviderProjection>>;
    unknownEntriesById: Readonly<Record<string, UnknownRecord>>;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION: PluginUiProjectionModel = Object.freeze({
    generation: null,
    translationsByPluginId: Object.freeze({}),
    structuredMessagesByKind: Object.freeze({}),
    sessionHeaderActionsById: Object.freeze({}),
    hostedWebById: Object.freeze({}),
    reactNativeBundlesById: Object.freeze({}),
    surfacePlacementsById: Object.freeze({}),
    surfacePlacementsByPlacement: Object.freeze({}),
    uiArtifactsById: Object.freeze({}),
    digestsByPluginId: Object.freeze({}),
    voiceProvidersById: Object.freeze({}),
    unknownEntriesById: Object.freeze({}),
});

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
}

function isTranslations(entry: UnknownRecord): entry is PluginUiTranslationsProjection {
    return entry.contributionKind === 'translations'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null;
}

function isSessionHeaderAction(entry: UnknownRecord): entry is PluginUiSessionHeaderActionProjection {
    return entry.contributionKind === 'sessionHeaderAction'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null;
}

function resolveSessionHeaderAction(
    entry: UnknownRecord,
    projection: Extract<DaemonContributionRegistryProjection, { v: 2 }>,
): PluginUiSessionHeaderActionProjection | null {
    if (!isSessionHeaderAction(entry)) {
        return null;
    }
    const descriptor = PluginSessionHeaderActionDescriptorV1Schema.safeParse({
        id: entry.descriptorId,
        title: entry.title,
        action: entry.action,
    });
    if (!descriptor.success) {
        return null;
    }
    const identity = createPluginContributionIdentity(
        typeof descriptor.data.action === 'string'
            ? { pluginId: entry.pluginId, localId: descriptor.data.action }
            : descriptor.data.action,
    );
    const qualifiedActionId = buildQualifiedPluginContributionKey(identity);
    const target = projection.actionsById[qualifiedActionId];
    if (
        !target
        || target.pluginId !== identity.pluginId
        || target.id !== identity.localId
        || !target.surfaces.includes('ui')
        || target.available === false
    ) {
        return null;
    }
    return Object.freeze({
        ...entry,
        title: descriptor.data.title,
        action: descriptor.data.action,
        qualifiedActionId,
    });
}

function isHostedWeb(entry: UnknownRecord): entry is PluginUiHostedWebProjection {
    return entry.contributionKind === 'hostedWeb'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.contributionId) !== null;
}

function isReactNativeBundle(entry: UnknownRecord): entry is PluginUiReactNativeBundleProjection {
    return entry.contributionKind === 'reactNativeBundle'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.contributionId) !== null;
}

function readSurfaceAvailability(value: unknown): PluginUiSurfaceAvailabilityProjection | null {
    const availability = asRecord(value);
    const state = readString(availability?.state);
    const reason = readString(availability?.reason);
    if (
        (state !== 'available' && state !== 'fallback' && state !== 'blocked' && state !== 'disabled')
        || reason === null
    ) {
        return null;
    }
    return Object.freeze({
        state,
        reason,
        diagnostics: Object.freeze(readStringArray(availability?.diagnostics)),
    });
}

function isSurfacePlacement(entry: UnknownRecord): entry is PluginUiSurfacePlacementProjection {
    return entry.contributionKind === 'surfacePlacement'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null
        && readString(entry.placement) !== null
        && asRecord(entry.target) !== null
        && asRecord(entry.renderer) !== null
        && asRecord(entry.display) !== null
        && readSurfaceAvailability(entry.availability) !== null;
}

function isUiArtifact(entry: UnknownRecord): entry is PluginUiArtifactProjection {
    return entry.contributionKind === 'uiArtifact'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.artifactId) !== null;
}

function isDigest(entry: UnknownRecord): entry is PluginUiDigestProjection {
    return entry.contributionKind === 'digest'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.digest) !== null;
}

export function normalizePluginUiProjection(
    projection: DaemonContributionRegistryProjection | null,
): PluginUiProjectionModel {
    if (!projection || projection.v !== 2) {
        return EMPTY_PLUGIN_UI_PROJECTION;
    }

    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const voiceProviderFamily = projection.familiesById.voiceProviders;
    if (voiceProviderFamily) {
        for (const rawEntry of Object.values(voiceProviderFamily.entriesById)) {
            const entry = asRecord(rawEntry);
            const pluginId = readString(entry?.pluginId);
            const id = readString(entry?.id);
            const contributionKey = readString(entry?.contributionKey);
            const generation = entry?.generation;
            const definition = PluginVoiceProviderContributionV1Schema.safeParse(entry?.definition);
            const recipientContract = entry?.recipientContract === undefined
                ? null
                : RecipientContractV1Schema.safeParse(entry.recipientContract);
            const recipientContractDigest = readString(entry?.recipientContractDigest);
            if (!pluginId || !id || !contributionKey || typeof generation !== 'number' || !definition.success) continue;
            const expectedKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId,
                localId: definition.data.id,
            }));
            if (
                id !== expectedKey
                || contributionKey !== expectedKey
                || generation !== projection.generation
                || (entry?.recipientContract !== undefined && (
                    !recipientContract?.success
                    || recipientContract.data.contribution.pluginId !== pluginId
                    || recipientContract.data.contribution.localId !== definition.data.id
                    || recipientContractDigest !== createRecipientContractDigestV1(recipientContract.data)
                ))
            ) continue;
            voiceProvidersById[id] = Object.freeze({
                ...entry,
                id,
                pluginId,
                generation,
                contributionKey,
                definition: definition.data,
                ...(recipientContract?.success && recipientContractDigest
                    ? {
                        recipientContract: recipientContract.data,
                        recipientContractDigest,
                    }
                    : {}),
            });
        }
    }

    const family = projection.familiesById.pluginUi;
    if (!family) {
        return Object.freeze({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: projection.generation,
            voiceProvidersById: Object.freeze(voiceProvidersById),
        });
    }

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const structuredMessagesByKind: Record<string, PluginUiStructuredMessageProjection> = {};
    const ambiguousStructuredMessageKinds = new Set<string>();
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiSurfacePlacementProjection> = {};
    const surfacePlacementsByPlacement: Record<string, PluginUiSurfacePlacementProjection[]> = {};
    const uiArtifactsById: Record<string, PluginUiArtifactProjection> = {};
    const digestsByPluginId: Record<string, PluginUiDigestProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};

    for (const rawEntry of Object.values(family.entriesById)) {
        const entry = asRecord(rawEntry);
        if (!entry) {
            continue;
        }
        if (isTranslations(entry)) {
            translationsByPluginId[entry.pluginId] = Object.freeze({
                ...entry,
                locales: Object.freeze(readStringArray(entry.locales)),
            });
        } else if (isStructuredMessage(entry)) {
            if (ambiguousStructuredMessageKinds.has(entry.kind)) {
                continue;
            }
            if (Object.hasOwn(structuredMessagesByKind, entry.kind)) {
                delete structuredMessagesByKind[entry.kind];
                ambiguousStructuredMessageKinds.add(entry.kind);
                continue;
            }
            addStructuredMessageToKindMap(structuredMessagesByKind, entry);
        } else if (isSessionHeaderAction(entry)) {
            const action = resolveSessionHeaderAction(entry, projection);
            if (action) {
                sessionHeaderActionsById[action.id] = action;
            }
        } else if (isHostedWeb(entry)) {
            hostedWebById[entry.id] = Object.freeze(entry);
        } else if (isReactNativeBundle(entry)) {
            reactNativeBundlesById[entry.id] = Object.freeze(entry);
        } else if (isSurfacePlacement(entry)) {
            const availability = readSurfaceAvailability(entry.availability);
            if (availability) {
                const placement = readString(entry.placement) ?? 'unknown';
                const target = asRecord(entry.target) ?? {};
                const renderer = asRecord(entry.renderer) ?? {};
                const display = asRecord(entry.display) ?? {};
                const rightSidebar = asRecord(entry.rightSidebar);
                const normalized = Object.freeze({
                    ...entry,
                    target: Object.freeze({ ...target }),
                    renderer: Object.freeze({ ...renderer }),
                    display: Object.freeze({ ...display }),
                    ...(rightSidebar ? { rightSidebar: Object.freeze({ ...rightSidebar }) } : {}),
                    availability,
                }) as PluginUiSurfacePlacementProjection;
                surfacePlacementsById[entry.id] = normalized;
                (surfacePlacementsByPlacement[placement] ??= []).push(normalized);
            }
        } else if (isUiArtifact(entry)) {
            uiArtifactsById[entry.id] = Object.freeze(entry);
        } else if (isDigest(entry)) {
            digestsByPluginId[entry.pluginId] = Object.freeze(entry);
        } else {
            const id = readString(entry.id);
            if (id !== null) {
                unknownEntriesById[id] = Object.freeze(entry);
            }
        }
    }

    const frozenSurfacePlacementsByPlacement = Object.freeze(Object.fromEntries(
        Object.entries(surfacePlacementsByPlacement).map(([placement, placements]) => [
            placement,
            Object.freeze([...placements].sort((left, right) => {
                const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER;
                const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER;
                if (leftOrder !== rightOrder) {
                    return leftOrder - rightOrder;
                }
                return left.id.localeCompare(right.id);
            })),
        ]),
    ));

    return Object.freeze({
        generation: projection.generation,
        translationsByPluginId: Object.freeze(translationsByPluginId),
        structuredMessagesByKind: Object.freeze(structuredMessagesByKind),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        surfacePlacementsByPlacement: frozenSurfacePlacementsByPlacement,
        uiArtifactsById: Object.freeze(uiArtifactsById),
        digestsByPluginId: Object.freeze(digestsByPluginId),
        voiceProvidersById: Object.freeze(voiceProvidersById),
        unknownEntriesById: Object.freeze(unknownEntriesById),
    });
}

export function resolvePluginUiProjectionState(
    previous: PluginUiProjectionModel,
    projection: DaemonContributionRegistryProjection | null,
): PluginUiProjectionModel {
    if (projection === null) {
        return previous;
    }
    if (projection.v !== 2) {
        return EMPTY_PLUGIN_UI_PROJECTION;
    }
    if (previous.generation !== null && projection.generation === previous.generation) {
        return previous;
    }
    return normalizePluginUiProjection(projection);
}

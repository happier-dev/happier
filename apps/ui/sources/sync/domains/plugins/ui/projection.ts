import type {
    DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginUiTranslationsProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'translations';
    locales: readonly string[];
}>;

export type PluginUiStructuredMessageProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'structuredMessage';
    descriptorId: string;
    kind: string;
}>;

export type PluginUiSessionSurfaceProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'sessionSurface';
    descriptorId: string;
    surfaceKind: string;
}>;

export type PluginUiSessionHeaderActionProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'sessionHeaderAction';
    descriptorId: string;
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

export type PluginUiProjectionModel = Readonly<{
    generation: number | null;
    translationsByPluginId: Readonly<Record<string, PluginUiTranslationsProjection>>;
    structuredMessagesByKind: Readonly<Record<string, PluginUiStructuredMessageProjection>>;
    sessionSurfacesById: Readonly<Record<string, PluginUiSessionSurfaceProjection>>;
    sessionHeaderActionsById: Readonly<Record<string, PluginUiSessionHeaderActionProjection>>;
    hostedWebById: Readonly<Record<string, PluginUiHostedWebProjection>>;
    reactNativeBundlesById: Readonly<Record<string, PluginUiReactNativeBundleProjection>>;
    uiArtifactsById: Readonly<Record<string, PluginUiArtifactProjection>>;
    digestsByPluginId: Readonly<Record<string, PluginUiDigestProjection>>;
    unknownEntriesById: Readonly<Record<string, UnknownRecord>>;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION: PluginUiProjectionModel = Object.freeze({
    generation: null,
    translationsByPluginId: Object.freeze({}),
    structuredMessagesByKind: Object.freeze({}),
    sessionSurfacesById: Object.freeze({}),
    sessionHeaderActionsById: Object.freeze({}),
    hostedWebById: Object.freeze({}),
    reactNativeBundlesById: Object.freeze({}),
    uiArtifactsById: Object.freeze({}),
    digestsByPluginId: Object.freeze({}),
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

function isStructuredMessage(entry: UnknownRecord): entry is PluginUiStructuredMessageProjection {
    return entry.contributionKind === 'structuredMessage'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null
        && readString(entry.kind) !== null;
}

function isSessionSurface(entry: UnknownRecord): entry is PluginUiSessionSurfaceProjection {
    return entry.contributionKind === 'sessionSurface'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null
        && readString(entry.surfaceKind) !== null;
}

function isSessionHeaderAction(entry: UnknownRecord): entry is PluginUiSessionHeaderActionProjection {
    return entry.contributionKind === 'sessionHeaderAction'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null;
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

    const family = projection.familiesById.pluginUi;
    if (!family) {
        return Object.freeze({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: projection.generation,
        });
    }

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const structuredMessagesByKind: Record<string, PluginUiStructuredMessageProjection> = {};
    const sessionSurfacesById: Record<string, PluginUiSessionSurfaceProjection> = {};
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
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
            structuredMessagesByKind[entry.kind] = Object.freeze(entry);
        } else if (isSessionSurface(entry)) {
            sessionSurfacesById[entry.id] = Object.freeze(entry);
        } else if (isSessionHeaderAction(entry)) {
            sessionHeaderActionsById[entry.id] = Object.freeze(entry);
        } else if (isHostedWeb(entry)) {
            hostedWebById[entry.id] = Object.freeze(entry);
        } else if (isReactNativeBundle(entry)) {
            reactNativeBundlesById[entry.id] = Object.freeze(entry);
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

    return Object.freeze({
        generation: projection.generation,
        translationsByPluginId: Object.freeze(translationsByPluginId),
        structuredMessagesByKind: Object.freeze(structuredMessagesByKind),
        sessionSurfacesById: Object.freeze(sessionSurfacesById),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        uiArtifactsById: Object.freeze(uiArtifactsById),
        digestsByPluginId: Object.freeze(digestsByPluginId),
        unknownEntriesById: Object.freeze(unknownEntriesById),
    });
}

export function resolvePluginUiProjectionState(
    previous: PluginUiProjectionModel,
    projection: DaemonContributionRegistryProjection | null,
): PluginUiProjectionModel {
    if (projection === null || projection.v !== 2) {
        return previous;
    }
    return normalizePluginUiProjection(projection);
}

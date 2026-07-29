import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import type {
    DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

export type PluginBrowserProjectionEntry = Readonly<Record<string, unknown>>;

type UnknownRecord = Readonly<Record<string, unknown>>;

type PluginBrowserTargetProjectionBase = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'browserTarget';
    contributionId: string;
    display: UnknownRecord & Readonly<{ title: string; addressLabel?: string }>;
}>;

export type PluginBrowserTargetProjection = PluginBrowserTargetProjectionBase & Readonly<
    | {
    target: UnknownRecord & Readonly<{ kind: 'externalUrl'; targetId: string; url: string }>;
    currentUrl: string;
    launchMode: 'newView' | 'currentView';
    profileMode: 'ephemeral' | 'session' | 'user' | 'plugin';
    }
    | {
    target: UnknownRecord & Readonly<{
        kind: 'hostedPluginWeb';
        targetId: string;
        pluginId: string;
        contributionId: string;
    }>;
    endpointUrl?: string;
    endpointExpiresAt?: number;
    }
>;

export type PluginBrowserActionProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'browserAction';
    contributionId: string;
    qualifiedActionId: string;
    targetId: string;
    placement: 'toolbar' | 'detailsPanel' | 'contextMenu';
    display: UnknownRecord & Readonly<{ title: string; iconToken?: string }>;
    order?: number;
}>;

export type PluginBrowserProjectionModel = Readonly<{
    generation: number | null;
    targetsById: Readonly<Record<string, PluginBrowserTargetProjection>>;
    actionsById: Readonly<Record<string, PluginBrowserActionProjection>>;
    unknownEntriesById: Readonly<Record<string, UnknownRecord>>;
}>;

export const EMPTY_PLUGIN_BROWSER_PROJECTION: PluginBrowserProjectionModel = Object.freeze({
    generation: null,
    targetsById: Object.freeze({}),
    actionsById: Object.freeze({}),
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

function isBrowserTarget(entry: UnknownRecord): entry is PluginBrowserTargetProjection {
    const id = readString(entry.id);
    const pluginId = readString(entry.pluginId);
    const contributionId = readString(entry.contributionId);
    const target = asRecord(entry.target);
    const targetId = readString(target?.targetId);
    const targetUrl = readString(target?.url);
    const currentUrl = readString(entry.currentUrl);
    return entry.contributionKind === 'browserTarget'
        && id !== null
        && pluginId !== null
        && contributionId !== null
        && id === `browserTarget:${pluginId}:${contributionId}`
        && target?.kind === 'externalUrl'
        && targetId === id
        && targetUrl !== null
        && asRecord(entry.display) !== null
        && readString(asRecord(entry.display)?.title) !== null
        && currentUrl === targetUrl
        && (entry.launchMode === 'newView' || entry.launchMode === 'currentView')
        && (entry.profileMode === 'ephemeral' || entry.profileMode === 'session' || entry.profileMode === 'user' || entry.profileMode === 'plugin');
}

function isBrowserAction(
    entry: UnknownRecord,
    projection: PluginProjectionV2,
    targetsById: Readonly<Record<string, PluginBrowserTargetProjection>>,
): entry is PluginBrowserActionProjection {
    const id = readString(entry.id);
    const pluginId = readString(entry.pluginId);
    const contributionId = readString(entry.contributionId);
    const qualifiedActionId = readString(entry.qualifiedActionId);
    const targetId = readString(entry.targetId);
    const declaredAction = qualifiedActionId
        ? projection.actionsById[qualifiedActionId]
        : undefined;
    const declaredQualifiedActionId = declaredAction
        ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: declaredAction.pluginId,
            localId: declaredAction.id,
        }))
        : null;
    return entry.contributionKind === 'browserAction'
        && id !== null
        && pluginId !== null
        && contributionId !== null
        && id === `browserAction:${pluginId}:${contributionId}`
        && qualifiedActionId !== null
        && declaredQualifiedActionId === qualifiedActionId
        && targetId !== null
        && targetsById[targetId] !== undefined
        && (entry.placement === 'toolbar' || entry.placement === 'detailsPanel' || entry.placement === 'contextMenu')
        && asRecord(entry.display) !== null
        && readString(asRecord(entry.display)?.title) !== null;
}

export function normalizePluginBrowserProjection(
    projection: DaemonContributionRegistryProjection | null,
): PluginBrowserProjectionModel {
    if (!projection || projection.v !== 2) {
        return EMPTY_PLUGIN_BROWSER_PROJECTION;
    }

    const family = projection.familiesById.pluginBrowser;
    if (!family) {
        return Object.freeze({
            ...EMPTY_PLUGIN_BROWSER_PROJECTION,
            generation: projection.generation,
        });
    }

    const targetsById: Record<string, PluginBrowserTargetProjection> = {};
    const actionsById: Record<string, PluginBrowserActionProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};
    const nonTargetEntries: Array<Readonly<{ entryKey: string; entry: UnknownRecord }>> = [];

    for (const [entryKey, rawEntry] of Object.entries(family.entriesById)) {
        const entry = asRecord(rawEntry);
        if (!entry) {
            continue;
        }
        if (entryKey === entry.id && isBrowserTarget(entry)) {
            targetsById[entry.id] = Object.freeze(entry);
        } else {
            nonTargetEntries.push({ entryKey, entry });
        }
    }

    for (const { entryKey, entry } of nonTargetEntries) {
        if (entryKey === entry.id && isBrowserAction(entry, projection, targetsById)) {
            actionsById[entry.id] = Object.freeze(entry);
        } else {
            const id = readString(entry.id);
            if (id !== null) {
                unknownEntriesById[id] = Object.freeze(entry);
            }
        }
    }

    return Object.freeze({
        generation: projection.generation,
        targetsById: Object.freeze(targetsById),
        actionsById: Object.freeze(actionsById),
        unknownEntriesById: Object.freeze(unknownEntriesById),
    });
}

export function resolvePluginBrowserProjectionState(
    previous: PluginBrowserProjectionModel,
    projection: DaemonContributionRegistryProjection | null,
): PluginBrowserProjectionModel {
    if (projection === null) {
        return previous;
    }
    if (projection.v !== 2) {
        return EMPTY_PLUGIN_BROWSER_PROJECTION;
    }
    return normalizePluginBrowserProjection(projection);
}

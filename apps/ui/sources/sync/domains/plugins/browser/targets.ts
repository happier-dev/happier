import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    PluginLocalizedStringV2Schema,
    type PluginContributionIdentityV1,
    type PluginLocalizedStringV2,
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
    display: UnknownRecord & Readonly<{ title: PluginLocalizedStringV2; addressLabel?: string }>;
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
    /**
     * The resolved target-action identity, carried beside the qualified key so
     * the browser placement dispatches a STRUCTURED reference. A qualified key
     * cannot be split back safely (`localId` may contain `/`), and a bare string
     * would be offered to the host-ActionSpec branch of the canonical dispatcher
     * first.
     */
    actionIdentity: PluginContributionIdentityV1;
    qualifiedActionId: string;
    targetId: string;
    placement: 'toolbar' | 'detailsPanel' | 'contextMenu';
    display: UnknownRecord & Readonly<{ title: PluginLocalizedStringV2; iconToken?: string }>;
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

function readLocalizedString(value: unknown): PluginLocalizedStringV2 | null {
    const parsed = PluginLocalizedStringV2Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
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
        && readLocalizedString(asRecord(entry.display)?.title) !== null
        && currentUrl === targetUrl
        && (entry.launchMode === 'newView' || entry.launchMode === 'currentView')
        && (entry.profileMode === 'ephemeral' || entry.profileMode === 'session' || entry.profileMode === 'user' || entry.profileMode === 'plugin');
}

/**
 * Resolve a projected browser action against the SAME projection generation's
 * action catalog, returning the entry with its target-action identity attached.
 * Fail-closed `null` when the declaration does not cross-check.
 */
function resolveBrowserAction(
    entry: UnknownRecord,
    projection: PluginProjectionV2,
    targetsById: Readonly<Record<string, PluginBrowserTargetProjection>>,
): PluginBrowserActionProjection | null {
    const id = readString(entry.id);
    const pluginId = readString(entry.pluginId);
    const contributionId = readString(entry.contributionId);
    const qualifiedActionId = readString(entry.qualifiedActionId);
    const targetId = readString(entry.targetId);
    const declaredAction = qualifiedActionId
        ? projection.actionsById[qualifiedActionId]
        : undefined;
    const actionIdentity = declaredAction
        ? createPluginContributionIdentity({
            pluginId: declaredAction.pluginId,
            localId: declaredAction.id,
        })
        : null;
    const declaredQualifiedActionId = actionIdentity
        ? buildQualifiedPluginContributionKey(actionIdentity)
        : null;
    const valid = entry.contributionKind === 'browserAction'
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
        && readLocalizedString(asRecord(entry.display)?.title) !== null;
    return valid && actionIdentity
        ? Object.freeze({
            ...entry,
            actionIdentity: Object.freeze({ ...actionIdentity }),
        }) as PluginBrowserActionProjection
        : null;
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
        const action = entryKey === entry.id
            ? resolveBrowserAction(entry, projection, targetsById)
            : null;
        if (action) {
            actionsById[action.id] = action;
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

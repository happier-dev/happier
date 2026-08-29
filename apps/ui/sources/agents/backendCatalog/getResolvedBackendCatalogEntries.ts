import {
    readBackendTargetRefV2,
    type AcpCatalogSettingsV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentCore, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID, LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED } from './legacyCompatAgents';
import { formatBackendTargetKeyV2, resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import {
    getAgentBackendCompatibilityTargets,
    readBackendTargetEnabled,
} from './backendTargetEnablement';
import type {
    MergedBackendCapabilities,
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { t } from '@/text';
import { resolveCliAuthBackgroundCheckSafe } from './resolveCliAuthBackgroundCheckSafe';
import { resolveAgentExecutionTargetForBackendTarget } from './resolveAgentExecutionTargetForBackendTarget';
import {
    resolveAgentCatalogProjection,
    type ResolvedAgentCatalogEntry,
} from './agentCatalogProjection';

export type ResolvedBackendCatalogEntry = Readonly<{
    /**
     * The canonical Agent presentation/identity record for this selectable
     * target. Consumers must not reconstruct visual identity from the runtime
     * carrier fields below.
     */
    agentCatalogEntry: ResolvedAgentCatalogEntry;
    backendTarget: PersistedBackendTargetRefV2;
    backendTargetKey: string;
    kind: 'builtInAgent' | 'configuredBackend' | 'pluginBackend';
    backendId: string;
    agentId: string;
    /**
     * The built-in provider identity (when one exists).
     *
     * For plugin/configured backends, do not collapse identity to the legacy compat carrier.
     * Use `iconAgentId` for UI icon fallback only.
     */
    catalogAgentId: AgentId | null;
    builtInAgentId: AgentId | null;
    iconAgentId: AgentId | null;
    capabilities?: MergedBackendCapabilities | null;
    compatibilityBackendTargets?: readonly BackendTargetRefV2[];
    title: string;
    subtitle: string | null;
    cliAuthBackgroundCheckSafe: boolean;
}>;

function isBackendTargetEnabled(
    backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined,
    backendTargetKey: string,
): boolean {
    return readBackendTargetEnabled({
        backendEnabledByTargetKey,
        canonicalTargetKey: backendTargetKey,
    });
}

function isResolvedEntryEnabled(
    backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined,
    entry: ResolvedBackendCatalogEntry,
): boolean {
    return readBackendTargetEnabled({
        backendEnabledByTargetKey,
        canonicalTargetKey: entry.backendTargetKey,
        compatibilityTargetKeys: (entry.compatibilityBackendTargets ?? []).map(formatBackendTargetKeyV2),
    });
}

type MergedProjectionInputs = Readonly<{
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
}>;

function resolveTargetAgentCatalogEntry(
    agentId: string,
    params: Readonly<{
        enabledAgentIds?: readonly string[];
        acpCatalogSettingsV1?: AcpCatalogSettingsV1;
        backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    }> & MergedProjectionInputs,
): ResolvedAgentCatalogEntry {
    return resolveAgentCatalogProjection(agentId, {
        enabledAgentIds: params.enabledAgentIds ?? [],
        backendEnabledByTargetKey: params.backendEnabledByTargetKey,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        mergedProviderProjectionById: params.mergedProviderProjectionById,
    });
}

function readPluginAgentSettingsBackendId(
    providerProjection: MergedProviderProjectionEntry | null,
): string | null {
    const settingsBackendId = typeof providerProjection?.settingsBackendId === 'string'
        ? providerProjection.settingsBackendId.trim()
        : '';
    return settingsBackendId || null;
}

function shouldCollapseProviderOwnedBackends(
    agentId: string,
    providerProjection: MergedProviderProjectionEntry,
    enabledProviderIds: ReadonlySet<string>,
): boolean {
    return enabledProviderIds.has(agentId)
        || providerProjection.isBuiltIn === true
        || isBundledAgentId(agentId);
}

function buildCollapsedDiscoveredBackendIdSet(params: Readonly<{
    enabledAgentIds: readonly string[];
}> & MergedProjectionInputs): ReadonlySet<string> {
    const enabledProviderIds = new Set(
        params.enabledAgentIds
            .map((agentId) => String(agentId ?? '').trim())
            .filter((agentId) => agentId.length > 0),
    );
    const collapsedBackendIds = new Set<string>();

    for (const [agentId, providerProjection] of Object.entries(params.mergedProviderProjectionById ?? {})) {
        if (!shouldCollapseProviderOwnedBackends(agentId, providerProjection, enabledProviderIds)) continue;
        const settingsBackendId = readPluginAgentSettingsBackendId(providerProjection);
        if (!settingsBackendId) continue;

        collapsedBackendIds.add(settingsBackendId);
        for (const [backendId, backendProjection] of Object.entries(params.mergedBackendProjectionById ?? {})) {
            if (backendProjection.agentId === agentId) {
                collapsedBackendIds.add(backendId);
            }
        }
    }

    return collapsedBackendIds;
}

function resolveProviderOwnedBackendCollapse(
    backendId: string,
    params: MergedProjectionInputs,
): Readonly<{ agentId: string }> | null {
    const backendProjection = readMergedBackendProjection(backendId, params);
    const agentId = typeof backendProjection?.agentId === 'string'
        ? backendProjection.agentId.trim()
        : '';
    if (!agentId) return null;

    const providerProjection = readMergedProviderProjection(agentId, params);
    if (!providerProjection) return null;
    if (!readPluginAgentSettingsBackendId(providerProjection)) return null;

    return { agentId };
}

function collectConfiguredProviderOwnedProviderIds(
    catalogBackends: readonly Readonly<{ id: string }>[],
    params: MergedProjectionInputs,
): ReadonlySet<string> {
    const agentIds = new Set<string>();

    for (const backend of catalogBackends) {
        const collapse = resolveProviderOwnedBackendCollapse(backend.id, params);
        if (collapse) {
            agentIds.add(collapse.agentId);
        }
    }

    return agentIds;
}

export function getResolvedBackendCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly string[];
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    collapseConfiguredBackendProviderSentinels?: boolean;
    discoveredBackendIds?: readonly string[];
}> & MergedProjectionInputs): ResolvedBackendCatalogEntry[] {
    const entriesByTargetKey = new Map<string, ResolvedBackendCatalogEntry>();
    const catalog = normalizeAcpCatalogSettingsV1(
        params.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
    );

    for (const enabledAgentIdRaw of params.enabledAgentIds) {
        const resolvedEntry = createBuiltInTargetEntry(String(enabledAgentIdRaw ?? '').trim(), params);
        if (!resolvedEntry) continue;
        if (!isResolvedEntryEnabled(params.backendEnabledByTargetKey, resolvedEntry)) {
            continue;
        }
        entriesByTargetKey.set(resolvedEntry.backendTargetKey, resolvedEntry);
    }

    // Installed Agents are first-class targets. The daemon's agents projection
    // is this machine's open Agent catalog and is the only place a standalone
    // installed Session Agent appears: the V2 projection carries no parallel
    // backend registry, and `enabledAgentIds` is the closed bundled seed which
    // can never name one. A bundled id stays owned by that seed so its
    // selection policy is applied exactly once.
    for (const projectedAgentId of Object.keys(params.mergedProviderProjectionById ?? {})) {
        const agentId = String(projectedAgentId ?? '').trim();
        if (!agentId || isBundledAgentId(agentId)) continue;
        const resolvedEntry = createProjectedAgentTargetEntry(agentId, params);
        if (!resolvedEntry) continue;
        if (entriesByTargetKey.has(resolvedEntry.backendTargetKey)) continue;
        if (!isResolvedEntryEnabled(params.backendEnabledByTargetKey, resolvedEntry)) {
            continue;
        }
        entriesByTargetKey.set(resolvedEntry.backendTargetKey, resolvedEntry);
    }

    if (params.collapseConfiguredBackendProviderSentinels === true) {
        for (const agentId of collectConfiguredProviderOwnedProviderIds(catalog.backends, params)) {
            const resolvedEntry = createBuiltInTargetEntry(agentId, params);
            if (!resolvedEntry) continue;
            if (!isResolvedEntryEnabled(params.backendEnabledByTargetKey, resolvedEntry)) {
                continue;
            }
            entriesByTargetKey.set(resolvedEntry.backendTargetKey, resolvedEntry);
        }
    }

    const collapsedProviderOwnedBackendIds = params.collapseConfiguredBackendProviderSentinels === true
        ? buildCollapsedDiscoveredBackendIdSet(params)
        : new Set<string>();
    const configuredBackendIds = new Set(catalog.backends.map((backend) => backend.id));

    for (const backend of catalog.backends) {
        if (
            collapsedProviderOwnedBackendIds.has(backend.id)
            || (
                params.collapseConfiguredBackendProviderSentinels === true
                && resolveProviderOwnedBackendCollapse(backend.id, params) !== null
            )
        ) {
            continue;
        }
        const canonicalTarget: BackendTargetRefV2 = {
            kind: 'backend',
            backendId: backend.id,
            configuredBackendId: backend.id,
        };
        const backendTargetKey = formatBackendTargetKeyV2(canonicalTarget);
        const backendProjection = readMergedBackendProjection(backend.id, params);
        const agentIdFromProjection = typeof backendProjection?.agentId === 'string' ? backendProjection.agentId.trim() : '';
        const agentId = agentIdFromProjection || backend.id;
        const providerProjection = agentId ? readMergedProviderProjection(agentId, params) : null;
        if (!isBackendTargetEnabled(
            params.backendEnabledByTargetKey,
            backendTargetKey,
        )) {
            continue;
        }
        entriesByTargetKey.set(backendTargetKey, {
            agentCatalogEntry: resolveTargetAgentCatalogEntry(agentId, params),
            backendTarget: canonicalTarget,
            backendTargetKey,
            kind: 'configuredBackend',
            backendId: backend.id,
            agentId,
            catalogAgentId: resolveProjectionCatalogAgentId(agentId, backendProjection, providerProjection),
            builtInAgentId: null,
            iconAgentId: resolveProjectionIconAgentId(agentId, backendProjection, providerProjection, null),
            capabilities: backendProjection?.capabilities ?? null,
            title: backendProjection?.title ?? providerProjection?.title ?? (backend.title || backend.name),
            subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? backend.name,
            cliAuthBackgroundCheckSafe: resolveCliAuthBackgroundCheckSafe(agentId, providerProjection),
        });
    }

    for (const discoveredTarget of collectDiscoveredTargets({
        ...params,
        configuredBackendIds,
        collapsedDiscoveredBackendIds: buildCollapsedDiscoveredBackendIdSet(params),
    })) {
        const backendTargetKey = formatBackendTargetKeyV2(discoveredTarget);
        if (entriesByTargetKey.has(backendTargetKey)) {
            continue;
        }
        const discoveredEntry = createDiscoveredTargetEntry(discoveredTarget, params);
        if (!discoveredEntry) continue;
        entriesByTargetKey.set(discoveredEntry.backendTargetKey, discoveredEntry);
    }

    const entries = [...entriesByTargetKey.values()];

    if (params.collapseConfiguredBackendProviderSentinels !== true) {
        return entries;
    }

    const hasConfiguredBackends = entries.some((entry) => entry.kind === 'configuredBackend');
    if (!hasConfiguredBackends) {
        return entries;
    }

    const configuredCatalogAgentIds = new Set(
        entries
            .filter((entry) => entry.kind === 'configuredBackend')
            .map((entry) => entry.catalogAgentId)
            .filter((agentId): agentId is AgentId => agentId !== null),
    );

    return entries.filter((entry) => {
        if (entry.kind !== 'builtInAgent') return true;
        if (entry.catalogAgentId === null) return true;
        return !configuredCatalogAgentIds.has(entry.catalogAgentId);
    });
}

export function resolveCatalogAgentIdForBackendTarget(target: BackendTargetRefV2): AgentId | null {
    return target.kind === 'backend' && isBundledAgentId(target.backendId) ? target.backendId : null;
}

/**
 * Resolves the operational Agent identity for a backend already selected from
 * the dynamic catalog. `catalogAgentId` is a closed built-in UI backing and
 * must not replace the projected Agent that owns the backend at runtime.
 */
export function resolveBackendTargetOperationalAgentId(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    selectedEntry?: Pick<ResolvedBackendCatalogEntry, 'agentId'> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): string | null {
    const projectedAgentId = typeof params.selectedEntry?.agentId === 'string'
        ? params.selectedEntry.agentId.trim()
        : '';
    if (projectedAgentId) return projectedAgentId;
    if (params.backendTarget.kind === 'agent') {
        const identity = params.backendTarget.identity;
        const exactProjectedAgentId = Object.entries(params.mergedProviderProjectionById ?? {})
            .find(([, projection]) => (
                projection.identity?.pluginId === identity.pluginId
                && projection.identity.localId === identity.localId
            ))?.[0]?.trim();
        if (exactProjectedAgentId) return exactProjectedAgentId;
        return resolveBundledAgentIdFromContributionIdentity(identity);
    }
    return resolveCatalogAgentIdForBackendTarget(params.backendTarget);
}

export function resolveOperationalBackendTargetForAgentSelection(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    selectedEntry?: Pick<ResolvedBackendCatalogEntry, 'agentId'> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): BackendTargetRefV2 | null {
    if (params.backendTarget.kind === 'backend') return params.backendTarget;
    const agentId = resolveBackendTargetOperationalAgentId(params);
    return agentId ? { kind: 'backend', backendId: agentId } : null;
}

function readMergedProviderProjection(
    agentId: string,
    params: MergedProjectionInputs,
): MergedProviderProjectionEntry | null {
    return params.mergedProviderProjectionById?.[agentId] ?? null;
}

function readMergedBackendProjection(
    backendId: string,
    params: MergedProjectionInputs,
): MergedBackendProjectionEntry | null {
    return params.mergedBackendProjectionById?.[backendId] ?? null;
}

function resolveProjectionCatalogAgentId(
    agentId: string,
    backendProjection: MergedBackendProjectionEntry | null,
    providerProjection: MergedProviderProjectionEntry | null,
): AgentId | null {
    const explicitAgentId = backendProjection?.catalogAgentId ?? providerProjection?.catalogAgentId ?? null;
    if (explicitAgentId && isBundledAgentId(explicitAgentId)) {
        return explicitAgentId;
    }
    if (isBundledAgentId(agentId)) {
        return agentId;
    }
    return null;
}

function resolveProjectionIconAgentId(
    agentId: string,
    backendProjection: MergedBackendProjectionEntry | null,
    providerProjection: MergedProviderProjectionEntry | null,
    fallbackAgentId: AgentId | null,
): AgentId | null {
    const explicitIconAgentId = backendProjection?.iconAgentId ?? providerProjection?.iconAgentId ?? null;
    if (explicitIconAgentId && isBundledAgentId(explicitIconAgentId)) {
        return explicitIconAgentId;
    }
    if (isBundledAgentId(agentId)) {
        return agentId;
    }
    return fallbackAgentId;
}

/**
 * Builds the selectable target row for one Agent named by the current agents
 * projection. An id the canonical target-key owner refuses cannot address a
 * runtime target at all, so it is not selectable rather than fatal to the whole
 * catalog read.
 */
function createProjectedAgentTargetEntry(
    agentId: string,
    params: MergedProjectionInputs,
): ResolvedBackendCatalogEntry | null {
    try {
        return createBuiltInTargetEntry(agentId, params);
    } catch {
        return null;
    }
}

function createBuiltInTargetEntry(agentId: string, params: MergedProjectionInputs): ResolvedBackendCatalogEntry | null {
    if (!agentId || agentId === LEGACY_COMPAT_PRIMARY_AGENT_ID) {
        return null;
    }
    const isBuiltInAgent = isBundledAgentId(agentId);
    const agentBackendProjection = readMergedBackendProjection(agentId, params);
    const backingAgentId = agentBackendProjection?.agentId ?? agentId;
    const agentProviderProjection = readMergedProviderProjection(backingAgentId, params);
    const settingsBackendId = readPluginAgentSettingsBackendId(agentProviderProjection);
    const targetBackendId = isBuiltInAgent ? agentId : settingsBackendId ?? agentId;
    const backendCarrierTarget: BackendTargetRefV2 = {
        kind: 'backend',
        backendId: targetBackendId,
    };
    const agentTarget = resolveAgentExecutionTargetForBackendTarget({
        backendTarget: backendCarrierTarget,
        daemonMergedProjectionInputs: {
            mergedProviderProjectionById: params.mergedProviderProjectionById ?? {},
            mergedBackendProjectionById: params.mergedBackendProjectionById ?? {},
        },
    });
    if (!agentTarget) return null;
    const canonicalTarget: PersistedBackendTargetRefV2 = agentTarget;
    const usesPluginAgentSettingsBackend = settingsBackendId !== null;
    const backendTargetKey = formatBackendTargetKeyV2(canonicalTarget);
    const backendProjection = settingsBackendId
        ? readMergedBackendProjection(settingsBackendId, params) ?? agentBackendProjection
        : agentBackendProjection;
    const resolvedAgentId = backendProjection?.agentId ?? backingAgentId;
    const providerProjection = readMergedProviderProjection(resolvedAgentId, params);
    const compatibilityBackendTargets = usesPluginAgentSettingsBackend
        ? getAgentBackendCompatibilityTargets({
            agentId: resolvedAgentId,
            canonicalTargetKey: backendTargetKey,
            mergedProviderProjectionById: params.mergedProviderProjectionById,
            mergedBackendProjectionById: params.mergedBackendProjectionById,
        })
        : !isBuiltInAgent && formatBackendTargetKeyV2(backendCarrierTarget) !== backendTargetKey
            // The current machine projection proves this exact runtime carrier
            // belongs to this qualified external Agent. Preserve that bounded
            // predecessor mapping without teaching the global key parser to
            // guess identities for arbitrary unknown backend ids.
            ? [backendCarrierTarget]
            : [];

    if (isBuiltInAgent) {
        const core = getAgentCore(agentId);
        return {
            agentCatalogEntry: resolveTargetAgentCatalogEntry(resolvedAgentId, params),
            backendTarget: canonicalTarget,
            backendTargetKey,
            kind: 'builtInAgent',
            backendId: targetBackendId,
            agentId: String(resolvedAgentId ?? '').trim() || agentId,
            catalogAgentId: resolveProjectionCatalogAgentId(resolvedAgentId, backendProjection, providerProjection),
            builtInAgentId: agentId,
            iconAgentId: resolveProjectionIconAgentId(resolvedAgentId, backendProjection, providerProjection, agentId),
            capabilities: backendProjection?.capabilities ?? null,
            ...(compatibilityBackendTargets.length > 0 ? { compatibilityBackendTargets } : {}),
            title: usesPluginAgentSettingsBackend ? t(core.displayNameKey) : backendProjection?.title ?? t(core.displayNameKey),
            subtitle: backendProjection?.subtitle ?? agentId,
            cliAuthBackgroundCheckSafe: resolveCliAuthBackgroundCheckSafe(resolvedAgentId, providerProjection),
        };
    }

    return {
        agentCatalogEntry: resolveTargetAgentCatalogEntry(resolvedAgentId, params),
        backendTarget: canonicalTarget,
        backendTargetKey,
        kind: 'pluginBackend',
        backendId: targetBackendId,
        agentId: String(resolvedAgentId ?? '').trim() || agentId,
        catalogAgentId: resolveProjectionCatalogAgentId(resolvedAgentId, backendProjection, providerProjection),
        builtInAgentId: null,
        iconAgentId: resolveProjectionIconAgentId(resolvedAgentId, backendProjection, providerProjection, null),
        capabilities: backendProjection?.capabilities ?? null,
        ...(compatibilityBackendTargets.length > 0 ? { compatibilityBackendTargets } : {}),
        title: usesPluginAgentSettingsBackend
            ? providerProjection?.title ?? formatAgentLikeIdForDisplay(agentId)
            : backendProjection?.title ?? providerProjection?.title ?? formatAgentLikeIdForDisplay(agentId),
        subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? agentId,
        cliAuthBackgroundCheckSafe: resolveCliAuthBackgroundCheckSafe(resolvedAgentId, providerProjection),
    };
}

function createDiscoveredTargetEntry(target: BackendTargetRefV2, params: MergedProjectionInputs): ResolvedBackendCatalogEntry | null {
    if (target.configuredBackendId) {
        const backendProjection = readMergedBackendProjection(target.backendId, params);
        const agentIdFromProjection = typeof backendProjection?.agentId === 'string' ? backendProjection.agentId.trim() : '';
        const agentId = agentIdFromProjection || target.backendId;
        const providerProjection = agentId ? readMergedProviderProjection(agentId, params) : null;
        const backendTargetKey = formatBackendTargetKeyV2(target);
        return {
            agentCatalogEntry: resolveTargetAgentCatalogEntry(agentId, params),
            backendTarget: target,
            backendTargetKey,
            kind: 'configuredBackend',
            backendId: target.backendId,
            agentId,
            catalogAgentId: resolveProjectionCatalogAgentId(agentId, backendProjection, providerProjection),
            builtInAgentId: null,
            iconAgentId: resolveProjectionIconAgentId(agentId, backendProjection, providerProjection, null),
            capabilities: backendProjection?.capabilities ?? null,
            title: backendProjection?.title ?? providerProjection?.title ?? formatAgentLikeIdForDisplay(target.backendId),
            subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? target.backendId,
            cliAuthBackgroundCheckSafe: resolveCliAuthBackgroundCheckSafe(agentId, providerProjection),
        };
    }

    return createBuiltInTargetEntry(target.backendId, params);
}

function collectDiscoveredTargets(params: Readonly<{
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    discoveredBackendIds?: readonly string[];
    configuredBackendIds?: ReadonlySet<string>;
    collapsedDiscoveredBackendIds?: ReadonlySet<string>;
}>): BackendTargetRefV2[] {
    const discoveredTargetsByKey = new Map<string, BackendTargetRefV2>();

    for (const backendId of params.discoveredBackendIds ?? []) {
        const normalizedBackendId = String(backendId ?? '').trim();
        if (!normalizedBackendId || normalizedBackendId.toLowerCase() === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        if (params.configuredBackendIds?.has(normalizedBackendId)) continue;
        if (params.collapsedDiscoveredBackendIds?.has(normalizedBackendId)) continue;
        const target: BackendTargetRefV2 = { kind: 'backend', backendId: normalizedBackendId };
        const key = formatBackendTargetKeyV2(target);
        if (params.backendEnabledByTargetKey?.[key] === false) continue;
        discoveredTargetsByKey.set(key, target);
    }

    const enabledByTarget = params.backendEnabledByTargetKey ?? null;
    if (enabledByTarget) {
        for (const [targetKey, isEnabled] of Object.entries(enabledByTarget)) {
            if (isEnabled === false) continue;
            const parsedTarget = parseBackendTargetFromUnknownKey(targetKey);
            if (!parsedTarget) continue;
            const key = formatBackendTargetKeyV2(parsedTarget);
            if (
                !parsedTarget.configuredBackendId
                && params.collapsedDiscoveredBackendIds?.has(parsedTarget.backendId)
            ) {
                continue;
            }
            if (params.backendEnabledByTargetKey?.[key] === false) continue;
            discoveredTargetsByKey.set(key, parsedTarget);
        }
    }

    return [...discoveredTargetsByKey.values()];
}

function parseBackendTargetFromUnknownKey(targetKey: string): BackendTargetRefV2 | null {
    try {
        return readBackendTargetRefV2(targetKey as BackendTargetRefV2Input);
    } catch {
        return null;
    }
}

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from './getResolvedBackendCatalogEntries';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';
import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';

function hasNonEmptyRecord(value: Readonly<Record<string, boolean>> | null | undefined): boolean {
    return !!(value && Object.keys(value).length > 0);
}

function hasNonEmptyAcpCatalogBackends(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const backends = (value as { backends?: unknown }).backends;
    return Array.isArray(backends) && backends.length > 0;
}

function buildEnabledBuiltInAgentIds(params: Readonly<{
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
}>): AgentId[] {
    const explicitEnabledAgentIds = Array.isArray(params.enabledAgentIds)
        ? params.enabledAgentIds.filter((agentId): agentId is AgentId => isAgentId(agentId))
        : null;

    return explicitEnabledAgentIds ?? getEnabledAgentIds({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey as Record<string, boolean> | null | undefined,
    });
}

function buildCanonicalProjectionBackendIdSet(inputs: DaemonMergedProjectionInputs): Set<string> {
    const backendIds = new Set<string>();
    for (const backendId of inputs.discoveredBackendIds ?? []) {
        const normalizedBackendId = String(backendId ?? '').trim();
        if (normalizedBackendId) {
            backendIds.add(normalizedBackendId);
        }
    }
    for (const backendId of Object.keys(inputs.mergedBackendProjectionById ?? {})) {
        const normalizedBackendId = String(backendId ?? '').trim();
        if (normalizedBackendId) {
            backendIds.add(normalizedBackendId);
        }
    }
    return backendIds;
}

function entryIsCanonicalProjectionEntry(
    entry: ResolvedBackendCatalogEntry,
    canonicalBackendIds: ReadonlySet<string>,
): boolean {
    if (entry.kind === 'builtInAgent') {
        return true;
    }
    return canonicalBackendIds.has(entry.backendId);
}

function resolveAvailableBackendTargets(params: Readonly<{
    enabledAgentIds?: ReadonlyArray<unknown>;
    enabledBuiltInAgentIds: ReadonlyArray<AgentId>;
    acpCatalogSettingsV1?: unknown;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>): ReadonlyArray<BackendTargetRefV2> | undefined {
    const hasMergedProjectionInputs = Boolean(params.daemonMergedProjectionInputs);
    const hasCatalogBackends = hasNonEmptyAcpCatalogBackends(params.acpCatalogSettingsV1);
    const hasAvailabilityInputs =
        params.enabledAgentIds !== undefined
        || hasNonEmptyRecord(params.backendEnabledByTargetKey ?? undefined)
        || hasCatalogBackends
        || hasMergedProjectionInputs;

    if (!hasAvailabilityInputs) {
        return undefined;
    }

    if (!hasMergedProjectionInputs && !hasCatalogBackends) {
        return params.enabledBuiltInAgentIds.map((agentId) => ({ kind: 'backend', backendId: agentId } satisfies BackendTargetRefV2));
    }

    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: params.enabledBuiltInAgentIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1 as any,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
        discoveredBackendIds: params.daemonMergedProjectionInputs?.discoveredBackendIds,
        mergedProviderProjectionById: params.daemonMergedProjectionInputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: params.daemonMergedProjectionInputs?.mergedBackendProjectionById,
    });

    const filteredEntries = params.daemonMergedProjectionInputs
        ? (() => {
            const canonicalBackendIds = buildCanonicalProjectionBackendIdSet(params.daemonMergedProjectionInputs);
            return entries.filter((entry) => entryIsCanonicalProjectionEntry(entry, canonicalBackendIds));
        })()
        : entries;

    return filteredEntries.map((entry) => entry.backendTarget);
}

function isDiscoveredPluginBackendTarget(target: BackendTargetRefV2): boolean {
    return target.kind === 'backend'
        && !target.configuredBackendId
        && !isLegacyCompatAgentType(target.backendId)
        && !isAgentId(target.backendId);
}

function normalizeBackendTargetForUi(target: BackendTargetRefV2): BackendTargetRefV2 {
    return target.configuredBackendId
        ? { kind: 'backend', backendId: target.backendId, configuredBackendId: target.configuredBackendId }
        : { kind: 'backend', backendId: target.backendId };
}

export function resolvePreferredBackendTargetFromProjection(params: Readonly<{
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: unknown;
    daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>): BackendTargetRefV2 {
    const enabledBuiltInAgentIds = buildEnabledBuiltInAgentIds({
        enabledAgentIds: params.enabledAgentIds,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
    });
    const availableBackendTargets = resolveAvailableBackendTargets({
        enabledAgentIds: params.enabledAgentIds,
        enabledBuiltInAgentIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
        daemonMergedProjectionInputs: params.daemonMergedProjectionInputs ?? null,
    });

    const resolved = resolvePreferredBackendTarget({
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        ...(availableBackendTargets ? { availableBackendTargets } : {}),
    });

    // Treat `sourceKind` as a compat-only hint, not a canonical UI identity carrier.
    return normalizeBackendTargetForUi(resolved);
}

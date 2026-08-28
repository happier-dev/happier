import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import { resolvePreferredBackendTargetFromProjection } from './resolvePreferredBackendTargetFromProjection';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

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

function normalizeBackendTargetForUi(target: PersistedBackendTargetRefV2): PersistedBackendTargetRefV2 {
    if (target.kind === 'agent') return target;
    return target.configuredBackendId
        ? { kind: 'backend', backendId: target.backendId, configuredBackendId: target.configuredBackendId }
        : { kind: 'backend', backendId: target.backendId };
}

export function resolvePreferredBackendTargetFromSettings(params: Readonly<{
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: unknown;
    daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>): PersistedBackendTargetRefV2 {
    if (params.daemonMergedProjectionInputs) {
        return resolvePreferredBackendTargetFromProjection(params);
    }

    const hasCatalogBackends = hasNonEmptyAcpCatalogBackends(params.acpCatalogSettingsV1);
    const hasAvailabilityInputs =
        params.enabledAgentIds !== undefined
        || hasNonEmptyRecord(params.backendEnabledByTargetKey ?? undefined)
        || hasCatalogBackends;

    const explicitEnabledAgentIds = Array.isArray(params.enabledAgentIds)
        ? params.enabledAgentIds.filter((agentId): agentId is AgentId => isBundledAgentId(agentId))
        : null;

    const enabledBuiltInAgentIds = (explicitEnabledAgentIds ?? getEnabledAgentIds({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey as Record<string, boolean> | null | undefined,
    })).filter((agentId) => !isLegacyCompatAgentType(agentId));

    const availableBackendTargets = hasAvailabilityInputs
        ? hasCatalogBackends
            ? (() => {
                const mergedEntries = getResolvedBackendCatalogEntries({
                    enabledAgentIds: enabledBuiltInAgentIds,
                    acpCatalogSettingsV1: params.acpCatalogSettingsV1 as any,
                    backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
                });
                const mergedTargets = mergedEntries.map((entry) => entry.backendTarget);
                const seenTargetKeys = new Set(mergedEntries.map((entry) => entry.backendTargetKey));
                const builtInTargets = enabledBuiltInAgentIds
                    .map((agentId) => ({
                        kind: 'agent',
                        identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId],
                    } satisfies PersistedBackendTargetRefV2))
                    .filter((target) => !seenTargetKeys.has(resolveBackendTargetKeyV2(target)));
                return [...builtInTargets, ...mergedTargets];
            })()
            : enabledBuiltInAgentIds.map((agentId) => ({
                kind: 'agent',
                identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId],
            } satisfies PersistedBackendTargetRefV2))
        : undefined;

    const resolved = resolvePreferredBackendTarget({
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        ...(availableBackendTargets ? { availableBackendTargets } : {}),
    });

    // Treat `sourceKind` as a compat-only hint, not a canonical UI identity carrier.
    return normalizeBackendTargetForUi(resolved);
}

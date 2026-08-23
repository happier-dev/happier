import {
    readBackendTargetRefV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from './getResolvedBackendCatalogEntries';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
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
        ? params.enabledAgentIds.filter((agentId): agentId is AgentId => isBundledAgentId(agentId))
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
    // An Agent the machine's projection names is projection truth too. The
    // current daemon V2 projection emits no parallel backend registry, so a
    // standalone installed Session Agent is canonical evidence carried only by
    // `agentsById`; ignoring it would reject the Agent's own target as if it
    // were a settings-only leftover.
    for (const [agentId, providerProjection] of Object.entries(inputs.mergedProviderProjectionById ?? {})) {
        const normalizedAgentId = String(agentId ?? '').trim();
        if (normalizedAgentId) {
            backendIds.add(normalizedAgentId);
        }
        const settingsBackendId = typeof providerProjection?.settingsBackendId === 'string'
            ? providerProjection.settingsBackendId.trim()
            : '';
        if (settingsBackendId) {
            backendIds.add(settingsBackendId);
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

function buildCanonicalAvailableTargetsFromResolvedEntries(
    entries: readonly ResolvedBackendCatalogEntry[],
): ReadonlyArray<BackendTargetRefV2> {
    const targets: BackendTargetRefV2[] = [];
    const seenTargetKeys = new Set<string>();

    const pushTarget = (target: BackendTargetRefV2) => {
        const targetKey = resolveBackendTargetKeyV2(target);
        if (seenTargetKeys.has(targetKey)) {
            return;
        }
        seenTargetKeys.add(targetKey);
        targets.push(target);
    };

    for (const entry of entries) {
        pushTarget(entry.backendTarget);
    }

    return targets;
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
        collapseConfiguredBackendProviderSentinels: hasMergedProjectionInputs,
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

    return buildCanonicalAvailableTargetsFromResolvedEntries(filteredEntries);
}

function resolveProjectedBuiltInBackendTarget(
    target: BackendTargetRefV2,
    entries: readonly ResolvedBackendCatalogEntry[],
): BackendTargetRefV2 {
    const targetKey = resolveBackendTargetKeyV2(target);
    for (const entry of entries) {
        if (entry.backendTargetKey === targetKey) {
            return entry.backendTarget;
        }
    }

    if (!isBundledAgentId(target.backendId)) {
        return target;
    }

    const projectedEntry = entries.find((entry) => entry.builtInAgentId === target.backendId);
    return projectedEntry?.backendTarget ?? target;
}

function normalizePersistedBackendTargetFromProjection(
    value: unknown,
    entries: readonly ResolvedBackendCatalogEntry[],
): unknown {
    let parsed: BackendTargetRefV2;
    try {
        parsed = readBackendTargetRefV2(value as BackendTargetRefV2Input);
    } catch {
        return value;
    }

    const targetKey = resolveBackendTargetKeyV2(parsed);
    for (const entry of entries) {
        if (entry.backendTargetKey === targetKey) {
            return entry.backendTarget;
        }
        if ((entry.compatibilityBackendTargets ?? []).some(
            (compatibilityTarget) => resolveBackendTargetKeyV2(compatibilityTarget) === targetKey,
        )) {
            return entry.backendTarget;
        }
    }

    return parsed;
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
    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: enabledBuiltInAgentIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1 as any,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
        collapseConfiguredBackendProviderSentinels: Boolean(params.daemonMergedProjectionInputs),
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
    const availableBackendTargets = resolveAvailableBackendTargets({
        enabledAgentIds: params.enabledAgentIds,
        enabledBuiltInAgentIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
        daemonMergedProjectionInputs: params.daemonMergedProjectionInputs ?? null,
    });

    const resolved = resolvePreferredBackendTarget({
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: normalizePersistedBackendTargetFromProjection(
            params.lastUsedBackendTarget,
            filteredEntries,
        ),
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        ...(availableBackendTargets ? { availableBackendTargets } : {}),
    });

    // Treat `sourceKind` as a compat-only hint, not a canonical UI identity carrier.
    return normalizeBackendTargetForUi(resolveProjectedBuiltInBackendTarget(resolved, filteredEntries));
}

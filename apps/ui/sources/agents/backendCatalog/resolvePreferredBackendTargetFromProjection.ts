import {
    PersistedBackendTargetRefV2Schema,
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { isBundledAgentId, type AgentId, type BundledAgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from './getResolvedBackendCatalogEntries';
import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

function buildEnabledBuiltInAgentIds(params: Readonly<{
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
}>): BundledAgentId[] {
    const explicitEnabledAgentIds = Array.isArray(params.enabledAgentIds)
        ? params.enabledAgentIds.filter((agentId): agentId is BundledAgentId => isBundledAgentId(agentId))
        : null;

    return explicitEnabledAgentIds ?? getEnabledAgentIds({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey as Record<string, boolean> | null | undefined,
    }).filter((agentId): agentId is BundledAgentId => isBundledAgentId(agentId));
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
    if (entry.kind === 'builtInAgent' || entry.kind === 'configuredBackend') {
        return true;
    }
    return canonicalBackendIds.has(entry.backendId);
}

function buildCanonicalAvailableTargetsFromResolvedEntries(
    entries: readonly ResolvedBackendCatalogEntry[],
): ReadonlyArray<PersistedBackendTargetRefV2> {
    const targets: PersistedBackendTargetRefV2[] = [];
    const seenTargetKeys = new Set<string>();

    const pushTarget = (target: PersistedBackendTargetRefV2) => {
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

function resolveProjectedBuiltInBackendTarget(
    target: PersistedBackendTargetRefV2,
    entries: readonly ResolvedBackendCatalogEntry[],
): PersistedBackendTargetRefV2 {
    const targetKey = resolveBackendTargetKeyV2(target);
    for (const entry of entries) {
        if (entry.backendTargetKey === targetKey) {
            return entry.backendTarget;
        }
    }

    if (target.kind !== 'backend' || !isBundledAgentId(target.backendId)) {
        return target;
    }

    const projectedEntry = entries.find((entry) => entry.builtInAgentId === target.backendId);
    return projectedEntry?.backendTarget ?? target;
}

function normalizePersistedBackendTargetFromProjection(
    value: unknown,
    entries: readonly ResolvedBackendCatalogEntry[],
): unknown {
    const canonical = PersistedBackendTargetRefV2Schema.safeParse(value);
    let parsed: PersistedBackendTargetRefV2;
    if (canonical.success) {
        parsed = canonical.data;
    } else {
        try {
            parsed = readBackendTargetRefV2(value as BackendTargetRefV2Input);
        } catch {
            return value;
        }
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

function normalizeBackendTargetForUi(target: PersistedBackendTargetRefV2): PersistedBackendTargetRefV2 {
    if (target.kind === 'agent') return target;
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
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>): PersistedBackendTargetRefV2 {
    const enabledBuiltInAgentIds = buildEnabledBuiltInAgentIds({
        enabledAgentIds: params.enabledAgentIds,
        backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
    });
    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: enabledBuiltInAgentIds,
        acpCatalogSnapshot: params.acpCatalogSnapshot,
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
    const availableBackendTargets = buildCanonicalAvailableTargetsFromResolvedEntries(filteredEntries);

    const resolved = resolvePreferredBackendTarget({
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: normalizePersistedBackendTargetFromProjection(
            params.lastUsedBackendTarget,
            filteredEntries,
        ),
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        availableBackendTargets,
    });

    // Treat `sourceKind` as a compat-only hint, not a canonical UI identity carrier.
    return normalizeBackendTargetForUi(resolveProjectedBuiltInBackendTarget(resolved, filteredEntries));
}

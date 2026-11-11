import {
    PersistedBackendTargetRefV2Schema,
    readBackendTargetRefV2,
    writePersistedBackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { DEFAULT_AGENT_ID, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId, type BundledAgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from './getResolvedBackendCatalogEntries';
import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { formatBackendTargetKeyV2, resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { findMachineAgentInventoryItemForTargetV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

/** Catalog inputs used when the caller does not already hold the available targets. */
export type BackendTargetCatalogInput = Readonly<{
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>;

export type BackendTargetPreferenceInput = Readonly<{
    candidateBackendTargets?: ReadonlyArray<unknown>;
    preferredBuiltInAgentIds?: ReadonlyArray<unknown>;
    availableBackendTargets?: ReadonlyArray<PersistedBackendTargetRefV2>;
    /** Held scoped readiness for an automatic launch; never probes or replaces explicit candidates. */
    machineAgents?: ReadonlyArray<Pick<MachineAgent, 'agentId' | 'definitionId' | 'state' | 'stale'>>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
}>;

function isAvailableBackendTarget(
    target: PersistedBackendTargetRefV2,
    availableTargets: ReadonlyArray<PersistedBackendTargetRefV2> | undefined,
): boolean {
    if (!availableTargets || availableTargets.length === 0) {
        return true;
    }
    const targetKey = formatBackendTargetKeyV2(target);
    return availableTargets.some((candidate) => formatBackendTargetKeyV2(candidate) === targetKey);
}

function resolveParseableBackendTarget(
    value: unknown,
    availableTargets: ReadonlyArray<PersistedBackendTargetRefV2> | undefined,
): PersistedBackendTargetRefV2 | null {
    const canonical = PersistedBackendTargetRefV2Schema.safeParse(value);
    let parsed: PersistedBackendTargetRefV2;
    if (canonical.success) {
        parsed = canonical.data;
    } else {
        try {
            parsed = readBackendTargetRefV2(value as BackendTargetRefV2Input);
        } catch {
            return null;
        }
    }
    if (parsed.kind === 'backend' && isLegacyCompatAgentType(parsed.backendId)) {
        return null;
    }
    // An explicit configured selection is authored intent, not a default. A
    // missing/unavailable row must leave the choice available for repair, not
    // silently replace it with a bundled Agent. Availability gates launch.
    if (parsed.kind === 'backend' && parsed.configuredBackendId) {
        return writePersistedBackendTargetRefV2(parsed);
    }
    if (parsed.kind === 'agent' && parsed.definitionId !== undefined) return parsed;
    return isAvailableBackendTarget(parsed, availableTargets) ? parsed : null;
}

function resolveAmongAvailableTargets(params: BackendTargetPreferenceInput & { machineAgents?: undefined }): PersistedBackendTargetRefV2;
function resolveAmongAvailableTargets(params: BackendTargetPreferenceInput): PersistedBackendTargetRefV2 | null;
function resolveAmongAvailableTargets(params: BackendTargetPreferenceInput): PersistedBackendTargetRefV2 | null {
    for (const candidateTarget of params.candidateBackendTargets ?? []) {
        const resolvedCandidate = resolveParseableBackendTarget(candidateTarget, params.availableBackendTargets);
        if (resolvedCandidate) {
            return resolvedCandidate;
        }
    }

    if (params.machineAgents !== undefined) {
        const readyAgents = params.machineAgents.filter(isMachineAgentReady);
        const readyTargets = (params.availableBackendTargets ?? []).filter(target => target.kind === 'agent'
            && findMachineAgentInventoryItemForTargetV1(readyAgents, target) !== undefined);
        if (readyTargets.length > 0) {
            const preferred = resolveAmongAvailableTargets({ ...params, candidateBackendTargets: undefined,
                machineAgents: undefined, availableBackendTargets: readyTargets });
            const preferredKey = formatBackendTargetKeyV2(preferred);
            return readyTargets.find(target => formatBackendTargetKeyV2(target) === preferredKey) ?? readyTargets[0]!;
        }
        return null;
    }

    const resolvedLastUsedBackendTarget = resolveParseableBackendTarget(
        params.lastUsedBackendTarget,
        params.availableBackendTargets,
    );
    if (resolvedLastUsedBackendTarget) {
        return resolvedLastUsedBackendTarget;
    }

    const availableBackendTargets = params.availableBackendTargets;

    const preferredBuiltInAgentIds: BundledAgentId[] = [];
    for (const preferredCandidate of params.preferredBuiltInAgentIds ?? []) {
        if (!isBundledAgentId(preferredCandidate)) {
            continue;
        }
        if (!preferredBuiltInAgentIds.includes(preferredCandidate)) {
            preferredBuiltInAgentIds.push(preferredCandidate);
        }
    }
    if (isBundledAgentId(params.lastUsedAgent) && !preferredBuiltInAgentIds.includes(params.lastUsedAgent)) {
        preferredBuiltInAgentIds.push(params.lastUsedAgent);
    }

    const defaultBuiltInAgentId = isBundledAgentId(params.defaultBuiltInAgentId)
        && resolveParseableBackendTarget({
            kind: 'agent',
            identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[params.defaultBuiltInAgentId],
        }, undefined)
        ? params.defaultBuiltInAgentId
        : DEFAULT_AGENT_ID;
    if (!preferredBuiltInAgentIds.includes(defaultBuiltInAgentId)) {
        preferredBuiltInAgentIds.push(defaultBuiltInAgentId);
    }
    // Availability may narrow the built-in default, but merely installing a
    // configured Agent is not an authored preference for that definition.
    for (const target of availableBackendTargets ?? []) {
        const agentId = target.kind === 'agent'
            ? target.definitionId === undefined ? resolveBundledAgentIdFromContributionIdentity(target.identity) : null
            : !target.configuredBackendId && isBundledAgentId(target.backendId) ? target.backendId : null;
        if (agentId && !preferredBuiltInAgentIds.includes(agentId)) preferredBuiltInAgentIds.push(agentId);
    }

    let preferredUnavailableTarget: PersistedBackendTargetRefV2 | null = null;
    for (const preferredBuiltInAgentId of preferredBuiltInAgentIds) {
        const builtInTarget = resolveParseableBackendTarget({
            kind: 'agent',
            identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[preferredBuiltInAgentId],
        }, undefined);
        if (!builtInTarget) continue;
        preferredUnavailableTarget ??= builtInTarget;
        if (isAvailableBackendTarget(builtInTarget, availableBackendTargets)) {
            return builtInTarget;
        }
    }

    return preferredUnavailableTarget ?? {
        kind: 'agent',
        identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[defaultBuiltInAgentId],
    };
}

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

/**
 * The one default-Agent decision: which Agent a new Session (or anything that
 * starts "like a new Session") runs on when nothing explicit was chosen.
 *
 * A caller that already holds the selectable targets passes
 * `availableBackendTargets`; otherwise availability comes from the Account's
 * backend catalog, narrowed to the exact Machine's projection when given, and
 * the result is normalized to the catalog's own identity for that target.
 * With `machineAgents` (held readiness), automatic selection requires a ready
 * Agent; explicit candidates retain the person's choice for launch or repair.
 */
export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput & BackendTargetCatalogInput & { machineAgents?: undefined }): PersistedBackendTargetRefV2;
export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput & BackendTargetCatalogInput): PersistedBackendTargetRefV2 | null;
export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput & BackendTargetCatalogInput): PersistedBackendTargetRefV2 | null {
    if (params.availableBackendTargets !== undefined) return resolveAmongAvailableTargets(params);
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

    const resolved = resolveAmongAvailableTargets({
        machineAgents: params.machineAgents,
        candidateBackendTargets: params.candidateBackendTargets?.map(target =>
            normalizePersistedBackendTargetFromProjection(target, filteredEntries)),
        preferredBuiltInAgentIds: params.preferredBuiltInAgentIds,
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: normalizePersistedBackendTargetFromProjection(
            params.lastUsedBackendTarget,
            filteredEntries,
        ),
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        availableBackendTargets,
    });
    if (!resolved) return null;

    // Treat `sourceKind` as a compat-only hint, not a canonical UI identity carrier.
    return normalizeBackendTargetForUi(resolveProjectedBuiltInBackendTarget(resolved, filteredEntries));
}

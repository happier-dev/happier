import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { BackendTargetRefSchema, buildBackendTargetKey } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

type BackendTargetPreferenceInput = Readonly<{
    candidateBackendTargets?: ReadonlyArray<unknown>;
    preferredBuiltInAgentIds?: ReadonlyArray<unknown>;
    availableBackendTargets?: ReadonlyArray<BackendTargetRefV1>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
}>;

function isAvailableBackendTarget(
    target: BackendTargetRefV1,
    availableTargets: ReadonlyArray<BackendTargetRefV1> | undefined,
): boolean {
    if (!availableTargets || availableTargets.length === 0) {
        return true;
    }
    const targetKey = buildBackendTargetKey(target);
    return availableTargets.some((candidate) => buildBackendTargetKey(candidate) === targetKey);
}

function resolveParseableBackendTarget(
    value: unknown,
    availableTargets: ReadonlyArray<BackendTargetRefV1> | undefined,
): BackendTargetRefV1 | null {
    const parsed = BackendTargetRefSchema.safeParse(value);
    if (!parsed.success) {
        return null;
    }
    return isAvailableBackendTarget(parsed.data, availableTargets) ? parsed.data : null;
}

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

export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput): BackendTargetRefV1 {
    for (const candidateTarget of params.candidateBackendTargets ?? []) {
        const resolvedCandidate = resolveParseableBackendTarget(candidateTarget, params.availableBackendTargets);
        if (resolvedCandidate) {
            return resolvedCandidate;
        }
    }

    const parsedLastUsedBackendTarget = BackendTargetRefSchema.safeParse(params.lastUsedBackendTarget);
    if (parsedLastUsedBackendTarget.success && isAvailableBackendTarget(parsedLastUsedBackendTarget.data, params.availableBackendTargets)) {
        return parsedLastUsedBackendTarget.data;
    }

    const preferredBuiltInAgentIds: AgentId[] = [];
    for (const preferredCandidate of params.preferredBuiltInAgentIds ?? []) {
        if (!isAgentId(preferredCandidate)) {
            continue;
        }
        if (!preferredBuiltInAgentIds.includes(preferredCandidate)) {
            preferredBuiltInAgentIds.push(preferredCandidate);
        }
    }
    if (isAgentId(params.lastUsedAgent) && !preferredBuiltInAgentIds.includes(params.lastUsedAgent)) {
        preferredBuiltInAgentIds.push(params.lastUsedAgent);
    }

    const defaultBuiltInAgentId = params.defaultBuiltInAgentId ?? DEFAULT_AGENT_ID;
    if (!preferredBuiltInAgentIds.includes(defaultBuiltInAgentId)) {
        preferredBuiltInAgentIds.push(defaultBuiltInAgentId);
    }

    for (const preferredBuiltInAgentId of preferredBuiltInAgentIds) {
        const builtInTarget: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: preferredBuiltInAgentId };
        if (isAvailableBackendTarget(builtInTarget, params.availableBackendTargets)) {
            return builtInTarget;
        }
    }

    if (params.availableBackendTargets?.length) {
        return params.availableBackendTargets[0];
    }

    return { kind: 'builtInAgent', agentId: defaultBuiltInAgentId };
}

export function resolvePreferredBackendTargetFromSettings(params: Readonly<{
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
    enabledAgentIds?: ReadonlyArray<unknown>;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: unknown;
}>): BackendTargetRefV1 {
    const hasAvailabilityInputs =
        params.enabledAgentIds !== undefined
        || hasNonEmptyRecord(params.backendEnabledByTargetKey ?? undefined)
        || hasNonEmptyAcpCatalogBackends(params.acpCatalogSettingsV1);

    const explicitEnabledAgentIds = Array.isArray(params.enabledAgentIds)
        ? params.enabledAgentIds.filter((agentId): agentId is AgentId => isAgentId(agentId))
        : null;

    const availableBackendTargets = hasAvailabilityInputs
        ? getResolvedBackendCatalogEntries({
            enabledAgentIds: explicitEnabledAgentIds ?? getEnabledAgentIds({
                backendEnabledByTargetKey: params.backendEnabledByTargetKey as Record<string, boolean> | null | undefined,
            }),
            acpCatalogSettingsV1: params.acpCatalogSettingsV1 as any,
            backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? undefined,
        }).map((entry) => entry.target)
        : undefined;

    return resolvePreferredBackendTarget({
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
        defaultBuiltInAgentId: params.defaultBuiltInAgentId,
        ...(availableBackendTargets ? { availableBackendTargets } : {}),
    });
}

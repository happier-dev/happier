import {
    PersistedBackendTargetRefV2Schema,
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId, type BundledAgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { formatBackendTargetKeyV2 } from './backendTargetKeyV2';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

export type BackendTargetPreferenceInput = Readonly<{
    candidateBackendTargets?: ReadonlyArray<unknown>;
    preferredBuiltInAgentIds?: ReadonlyArray<unknown>;
    availableBackendTargets?: ReadonlyArray<PersistedBackendTargetRefV2>;
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
    return isAvailableBackendTarget(parsed, availableTargets) ? parsed : null;
}

export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput): PersistedBackendTargetRefV2 {
    for (const candidateTarget of params.candidateBackendTargets ?? []) {
        const resolvedCandidate = resolveParseableBackendTarget(candidateTarget, params.availableBackendTargets);
        if (resolvedCandidate) {
            return resolvedCandidate;
        }
    }

    const resolvedLastUsedBackendTarget = resolveParseableBackendTarget(
        params.lastUsedBackendTarget,
        params.availableBackendTargets,
    );
    if (resolvedLastUsedBackendTarget) {
        return resolvedLastUsedBackendTarget;
    }

    const hasStoredBackendTargetPreference = params.lastUsedBackendTarget !== undefined && params.lastUsedBackendTarget !== null;
    if (!hasStoredBackendTargetPreference) {
        const preferredConfiguredBackendTarget = params.availableBackendTargets?.find(
            (target) => target.kind === 'backend' && !!target.configuredBackendId,
        ) ?? null;
        if (preferredConfiguredBackendTarget) {
            return preferredConfiguredBackendTarget;
        }
    }

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
        ? params.defaultBuiltInAgentId
        : DEFAULT_AGENT_ID;
    if (!preferredBuiltInAgentIds.includes(defaultBuiltInAgentId)) {
        preferredBuiltInAgentIds.push(defaultBuiltInAgentId);
    }

    for (const preferredBuiltInAgentId of preferredBuiltInAgentIds) {
        const builtInTarget: PersistedBackendTargetRefV2 = {
            kind: 'agent',
            identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[preferredBuiltInAgentId],
        };
        if (isAvailableBackendTarget(builtInTarget, params.availableBackendTargets)) {
            return builtInTarget;
        }
    }

    if (params.availableBackendTargets?.length) {
        return params.availableBackendTargets[0];
    }

    return {
        kind: 'agent',
        identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[defaultBuiltInAgentId],
    };
}

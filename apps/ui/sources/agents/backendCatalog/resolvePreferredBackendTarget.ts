import {
    readBackendTargetRefV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { backendTargetsMatch, formatBackendTargetKeyV2 } from './backendTargetKeyV2';

export type BackendTargetPreferenceInput = Readonly<{
    candidateBackendTargets?: ReadonlyArray<unknown>;
    preferredBuiltInAgentIds?: ReadonlyArray<unknown>;
    availableBackendTargets?: ReadonlyArray<BackendTargetRefV2>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    defaultBuiltInAgentId?: AgentId;
}>;

function isAvailableBackendTarget(
    target: BackendTargetRefV2,
    availableTargets: ReadonlyArray<BackendTargetRefV2> | undefined,
): boolean {
    if (!availableTargets || availableTargets.length === 0) {
        return true;
    }
    const targetKey = formatBackendTargetKeyV2(target);
    return availableTargets.some((candidate) => formatBackendTargetKeyV2(candidate) === targetKey);
}

function resolveParseableBackendTarget(
    value: unknown,
    availableTargets: ReadonlyArray<BackendTargetRefV2> | undefined,
): BackendTargetRefV2 | null {
    let parsed: BackendTargetRefV2;
    try {
        parsed = readBackendTargetRefV2(value as BackendTargetRefV2Input);
    } catch {
        return null;
    }
    if (isLegacyCompatAgentType(parsed.backendId)) {
        return null;
    }
    return isAvailableBackendTarget(parsed, availableTargets) ? parsed : null;
}

export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput): BackendTargetRefV2 {
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
        const preferredConfiguredBackendTarget = params.availableBackendTargets?.find((target) => !!target.configuredBackendId) ?? null;
        if (preferredConfiguredBackendTarget) {
            return preferredConfiguredBackendTarget;
        }
    }

    const preferredBuiltInAgentIds: AgentId[] = [];
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

    const defaultBuiltInAgentId = params.defaultBuiltInAgentId ?? DEFAULT_AGENT_ID;
    if (!preferredBuiltInAgentIds.includes(defaultBuiltInAgentId)) {
        preferredBuiltInAgentIds.push(defaultBuiltInAgentId);
    }

    for (const preferredBuiltInAgentId of preferredBuiltInAgentIds) {
        const builtInTarget: BackendTargetRefV2 = { kind: 'backend', backendId: preferredBuiltInAgentId };
        if (isAvailableBackendTarget(builtInTarget, params.availableBackendTargets)) {
            return builtInTarget;
        }
    }

    if (params.availableBackendTargets?.length) {
        return params.availableBackendTargets[0];
    }

    return { kind: 'backend', backendId: defaultBuiltInAgentId };
}

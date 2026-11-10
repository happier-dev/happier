import {
    PersistedBackendTargetRefV2Schema,
    readBackendTargetRefV2,
    writePersistedBackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { DEFAULT_AGENT_ID, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId, type BundledAgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { formatBackendTargetKeyV2 } from './backendTargetKeyV2';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

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

export function resolvePreferredBackendTarget(params: BackendTargetPreferenceInput): PersistedBackendTargetRefV2 {
    for (const candidateTarget of params.candidateBackendTargets ?? []) {
        const resolvedCandidate = resolveParseableBackendTarget(candidateTarget, params.availableBackendTargets);
        if (resolvedCandidate) {
            return resolvedCandidate;
        }
    }

    if (params.machineAgents) {
        const readyKeys = new Set(params.machineAgents.filter(isMachineAgentReady).map(buildMachineAgentInventoryKey));
        const readyTargets = (params.availableBackendTargets ?? []).filter(target => target.kind === 'agent' && (
            readyKeys.has(buildMachineAgentInventoryKey({ agentId: target.identity.localId, definitionId: target.definitionId }))
            || readyKeys.has(buildMachineAgentInventoryKey({ agentId: buildQualifiedPluginContributionKey(target.identity), definitionId: target.definitionId }))
        ));
        if (readyTargets.length > 0) {
            const preferred = resolvePreferredBackendTarget({ ...params, candidateBackendTargets: undefined,
                machineAgents: undefined, availableBackendTargets: readyTargets });
            const preferredKey = formatBackendTargetKeyV2(preferred);
            return readyTargets.find(target => formatBackendTargetKeyV2(target) === preferredKey) ?? readyTargets[0]!;
        }
        // No ready alternative: retain the normal choice so launch reports its
        // actual named refusal rather than inventing an unknown-Agent result.
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

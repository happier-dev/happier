import { AgentExecutionTargetV1Schema, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { PluginContributionIdentityV1Schema, readPersistedAgentContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readBackendTargetRefV2, type BackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { stripBackendTargetSourceKind } from './backendTargetRouteParams';

import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';

/**
 * Converts the UI's backend-selection vocabulary into the strict Action
 * target vocabulary. The daemon projection is authoritative for plugin Agents,
 * including the qualified Agent contribution behind a configured selection.
 * Bundled Agent identities are the only local fallback.
 */
export function resolveAgentExecutionTargetForBackendTarget(params: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    daemonMergedProjectionInputs?: Pick<
        DaemonMergedProjectionInputs,
        'mergedBackendProjectionById' | 'mergedProviderProjectionById'
    > | null;
}>): AgentExecutionTargetV1 | null {
    const canonicalAgentTarget = AgentExecutionTargetV1Schema.safeParse(params.backendTarget);
    if (canonicalAgentTarget.success) {
        return canonicalAgentTarget.data;
    }

    let backendTarget;
    try {
        backendTarget = readBackendTargetRefV2(params.backendTarget);
    } catch {
        return null;
    }

    const projectedAgentId = params.daemonMergedProjectionInputs
        ?.mergedBackendProjectionById?.[backendTarget.backendId]?.agentId;
    const agentId = typeof projectedAgentId === 'string' && projectedAgentId.trim()
        ? projectedAgentId.trim()
        : backendTarget.backendId;
    const projectedIdentity = params.daemonMergedProjectionInputs
        ?.mergedProviderProjectionById?.[agentId]?.identity;
    const parsedProjectedIdentity = PluginContributionIdentityV1Schema.safeParse(projectedIdentity);
    if (parsedProjectedIdentity.success) {
        return {
            kind: 'agent',
            identity: parsedProjectedIdentity.data,
        };
    }

    // A configured backend has no local qualified-identity fallback. Only its
    // machine projection can prove which executable Agent contribution owns it;
    // never reinterpret the configured id itself as an Agent identity.
    if (backendTarget.configuredBackendId) {
        return null;
    }

    if (!isBundledAgentId(agentId)) {
        return null;
    }

    return {
        kind: 'agent',
        identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId],
    };
}

/**
 * Resolves the canonical Agent execution target from a persisted UI selection:
 * the retained `backendTarget` vocabulary when present, otherwise the bundled or
 * persisted contribution identity named by the compat Agent id. Returns null
 * when neither names a resolvable Agent contribution.
 */
export function resolveAgentExecutionTargetForPersistedSelection(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    fallbackAgentId?: unknown;
}>): AgentExecutionTargetV1 | null {
    if (params.backendTarget) {
        const resolved = resolveAgentExecutionTargetForBackendTarget({
            backendTarget: stripBackendTargetSourceKind(params.backendTarget),
        });
        if (resolved) return resolved;
    }
    if (typeof params.fallbackAgentId === 'string' && isBundledAgentId(params.fallbackAgentId)) {
        return resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: params.fallbackAgentId },
        });
    }
    const identity = readPersistedAgentContributionIdentityV1(params.fallbackAgentId);
    return identity ? AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity }) : null;
}

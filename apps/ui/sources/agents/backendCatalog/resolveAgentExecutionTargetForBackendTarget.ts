import { AgentExecutionTargetV1Schema, AgentExecutionTargetV1StoredSchema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { PluginContributionIdentityV1Schema, readPersistedAgentContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readBackendTargetRefV2, type BackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { stripBackendTargetSourceKind } from './backendTargetRouteParams';

import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';

/**
 * Converts the UI's backend-selection vocabulary into the strict Action
 * target vocabulary. Configured selections are instances of the declared
 * Custom ACP Agent; daemon projections resolve other installed plugin Agents.
 * Bundled Agent identities are the only local fallback when no target is stored.
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

    if (backendTarget.configuredBackendId) {
        return AgentExecutionTargetV1Schema.parse({ kind: 'agent',
            identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: backendTarget.configuredBackendId });
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
        const target = AgentExecutionTargetV1Schema.safeParse({
            kind: 'agent',
            identity: parsedProjectedIdentity.data,
        });
        return target.success ? target.data : null;
    }

    if (!isBundledAgentId(agentId)) {
        return null;
    }

    const bundledTarget = AgentExecutionTargetV1Schema.safeParse({
        kind: 'agent',
        identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId],
    });
    return bundledTarget.success ? bundledTarget.data : null;
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
        const stored = AgentExecutionTargetV1StoredSchema.safeParse(params.backendTarget);
        if (stored.success) return stored.data;
        return resolveAgentExecutionTargetForBackendTarget({
            backendTarget: stripBackendTargetSourceKind(params.backendTarget),
        });
    }
    if (typeof params.fallbackAgentId === 'string' && isBundledAgentId(params.fallbackAgentId)) {
        return resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: params.fallbackAgentId },
        });
    }
    const identity = readPersistedAgentContributionIdentityV1(params.fallbackAgentId);
    const target = AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity });
    return target.success ? target.data : null;
}

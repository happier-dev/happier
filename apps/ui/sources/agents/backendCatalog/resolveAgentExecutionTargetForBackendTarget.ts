import {
    AgentExecutionTargetV1Schema,
    PluginContributionIdentityV1Schema,
    readBackendTargetRefV2,
    readPersistedAgentContributionIdentityV1,
    type AgentExecutionTargetV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';
import { stripBackendTargetSourceKind } from './backendTargetRouteParams';

import type { DaemonMergedProjectionInputs } from './loadDaemonMergedProjectionInputs';

/**
 * Converts the UI's backend-selection vocabulary into the strict Action
 * target vocabulary. The daemon projection is authoritative for non-configured
 * plugin Agents; configured backend instances fail closed until the Action
 * contract can represent their exact identity. Bundled Agent identities are
 * the only local fallback.
 */
export function resolveAgentExecutionTargetForBackendTarget(params: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    daemonMergedProjectionInputs?: Pick<
        DaemonMergedProjectionInputs,
        'mergedBackendProjectionById' | 'mergedProviderProjectionById'
    > | null;
}>): AgentExecutionTargetV1 | null {
    let backendTarget;
    try {
        backendTarget = readBackendTargetRefV2(params.backendTarget);
    } catch {
        return null;
    }

    // `AgentExecutionTargetV1` identifies an Agent contribution, not a configured
    // backend instance. Collapsing this target would select an arbitrary instance,
    // so that transition remains unavailable until the Action contract owns it.
    if (backendTarget.configuredBackendId) {
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

    if (!isBundledAgentId(agentId)) {
        return null;
    }

    return {
        kind: 'agent',
        identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId],
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

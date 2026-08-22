import {
    PluginContributionIdentityV1Schema,
    readBackendTargetRefV2,
    type AgentExecutionTargetV1,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

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

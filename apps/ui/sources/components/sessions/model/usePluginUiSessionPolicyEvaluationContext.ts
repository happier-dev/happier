import * as React from 'react';
import { isFeatureId } from '@happier-dev/protocol/features/catalog';

import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    type ServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import {
    createPluginUiSessionPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
    type PluginUiSessionPolicyFacts,
} from '@/sync/domains/plugins/ui/policy';

/**
 * One mounted-Session adapter from incumbent Session/feature facts to plugin
 * availability. Callers retain ownership of those facts; this hook only keeps
 * their projection identical across Session placements.
 */
type SessionPluginPolicyInput = Readonly<{
    platform: PluginUiPolicyEvaluationContext['platform'];
    serverId: string | null;
    settings: FeatureLocalPolicySettings;
    serverFeaturesSnapshot: ServerFeaturesRuntimeSnapshot;
    facts: PluginUiSessionPolicyFacts;
}>;

/** Shared facts projection for mounted surfaces and Action discovery of that exact Session. */
export function createSessionPluginPolicyEvaluationContext(input: SessionPluginPolicyInput): PluginUiPolicyEvaluationContext {
    return createPluginUiSessionPolicyEvaluationContext({
        platform: input.platform,
        channel: 'internal',
        isFeatureEnabled: (featureId) => {
            if (!isFeatureId(featureId)) return false;
            return resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings: input.settings,
                snapshot: input.serverFeaturesSnapshot, scope: { scopeKind: 'spawn', ...(input.serverId ? { serverId: input.serverId } : {}) } })?.state === 'enabled';
        },
    }, input.facts);
}

export function usePluginUiSessionPolicyEvaluationContext(input: SessionPluginPolicyInput): PluginUiPolicyEvaluationContext {
    const {
        browserExists,
        machineId,
        pluginEnabled,
        projectId,
        sessionAgentId,
        sessionState,
    } = input.facts;

    return React.useMemo(() => createSessionPluginPolicyEvaluationContext(input), [
        browserExists,
        input.platform,
        input.serverFeaturesSnapshot,
        input.serverId,
        input.settings,
        machineId,
        pluginEnabled,
        projectId,
        sessionAgentId,
        sessionState,
    ]);
}

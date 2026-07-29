import * as React from 'react';
import {
    readExternalSessionsSettingsV1,
    removeExternalSessionsAutoLinkSourcePolicyV1,
} from '@happier-dev/protocol';

import { sync } from '@/sync/sync';

import type {
    ExternalSessionsAutoLinkSourceDescriptor,
    ExternalSessionsQualifiedAgent,
} from './externalSessionsIntegrationModel';

type KnownExternalSessionsAgent = Readonly<{
    agent: ExternalSessionsQualifiedAgent;
    agentTitle: string;
}>;

type ExternalSessionsAutoLinkSourceScope = Readonly<{
    machineId: string;
    agent: ExternalSessionsQualifiedAgent;
}>;

function agentKey(agent: ExternalSessionsQualifiedAgent): string {
    return `${agent.pluginId}\u0000${agent.localId}`;
}

function sameAgent(
    left: ExternalSessionsQualifiedAgent,
    right: ExternalSessionsQualifiedAgent,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function useExternalSessionsAutoLinkSources(params: Readonly<{
    rawSettings: unknown;
    knownAgents: readonly KnownExternalSessionsAgent[];
    enabled?: boolean;
    scope?: ExternalSessionsAutoLinkSourceScope;
}>): readonly ExternalSessionsAutoLinkSourceDescriptor[] {
    const scopedMachineId = params.scope?.machineId;
    const scopedAgentPluginId = params.scope?.agent.pluginId;
    const scopedAgentLocalId = params.scope?.agent.localId;
    const agentTitleByKey = React.useMemo(
        () => new Map(params.knownAgents.map((knownAgent) => [
            agentKey(knownAgent.agent),
            knownAgent.agentTitle,
        ] as const)),
        [params.knownAgents],
    );

    return React.useMemo(() => {
        if (params.enabled === false) return [];
        const settings = readExternalSessionsSettingsV1(params.rawSettings);
        const scopedAgent = scopedAgentPluginId && scopedAgentLocalId
            ? {
                pluginId: scopedAgentPluginId,
                localId: scopedAgentLocalId,
            }
            : null;
        return (settings?.autoLinkSourcePolicies ?? [])
            .filter((policy) => (
                scopedMachineId === undefined
                || (
                    policy.machineId === scopedMachineId
                    && scopedAgent !== null
                    && sameAgent(policy.qualifiedIdentity.agent, scopedAgent)
                )
            ))
            .map((policy) => ({
                machineId: policy.machineId,
                agent: policy.qualifiedIdentity.agent,
                agentTitle: agentTitleByKey.get(agentKey(policy.qualifiedIdentity.agent))
                    ?? `${policy.qualifiedIdentity.agent.localId} (${policy.qualifiedIdentity.agent.pluginId})`,
                sourcePolicyId: policy.sourcePolicyId,
                enabled: true,
                canChange: true,
                setEnabled: async (enabled: boolean) => {
                    if (enabled) return;
                    await sync.mutateAccountSettings((raw) => ({
                        ...raw,
                        externalSessionsSettingsV1:
                            removeExternalSessionsAutoLinkSourcePolicyV1(
                                raw.externalSessionsSettingsV1,
                                {
                                    machineId: policy.machineId,
                                    qualifiedIdentity: policy.qualifiedIdentity,
                                    sourcePolicyId: policy.sourcePolicyId,
                                },
                            ),
                    }));
                },
            }));
    }, [
        agentTitleByKey,
        params.enabled,
        params.rawSettings,
        scopedAgentLocalId,
        scopedAgentPluginId,
        scopedMachineId,
    ]);
}

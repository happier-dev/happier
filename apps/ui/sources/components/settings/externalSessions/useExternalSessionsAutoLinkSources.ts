import * as React from 'react';
import {
    readExternalSessionsSettingsV1,
} from '@happier-dev/protocol/sessions/external/followLifecycleV1';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storageStore';

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
    accountOperationsAvailable?: boolean;
    scope?: ExternalSessionsAutoLinkSourceScope;
}>): readonly ExternalSessionsAutoLinkSourceDescriptor[] {
    const scopedMachineId = params.scope?.machineId;
    const scopedAgentPluginId = params.scope?.agent.pluginId;
    const scopedAgentLocalId = params.scope?.agent.localId;
    const writeSetting = useSettingActionWriter();
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
                canChange: params.accountOperationsAvailable !== false,
                setEnabled: async (enabled: boolean) => {
                    if (params.accountOperationsAvailable === false) return;
                    if (enabled) return;
                    const settingsVersion = storage.getState().settingsVersion;
                    if (settingsVersion === null) throw new Error('Account settings version is unavailable');
                    requireActionSuccess(await writeSetting({ anchor: 'externalSessions.autoLinkSources' }, {
                        machineId: policy.machineId,
                        qualifiedIdentity: policy.qualifiedIdentity,
                        sourcePolicyId: policy.sourcePolicyId,
                    }, { expectedSettingsVersion: settingsVersion }));
                },
            }));
    }, [
        agentTitleByKey,
        params.accountOperationsAvailable,
        params.enabled,
        params.rawSettings,
        scopedAgentLocalId,
        scopedAgentPluginId,
        scopedMachineId,
        writeSetting,
    ]);
}

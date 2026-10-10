import { prepareDefaultProviderStateSharingChangeV1, readProviderStateSharingRiskAgentIdsV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ConnectedServicesProviderStateSharingSettingsV1 } from '@happier-dev/protocol/account/settings/connected-services';

export type ProviderStateSharingSettingsMutation = (current: ConnectedServicesProviderStateSharingSettingsV1)
    => ConnectedServicesProviderStateSharingSettingsV1 | null;
export type ProviderStateSharingSettingsWriter = (mutation: ProviderStateSharingSettingsMutation) => void;

export function resolveProviderStateSharingAgentIds(agentIds: readonly AgentId[] = AGENT_IDS): readonly AgentId[] {
    return agentIds.filter(agentId => {
        const capability = getAgentCore(agentId)?.connectedServices?.providerStateSharing;
        return capability?.config.supported === true || capability?.state.supported === true;
    });
}

function sharedStateRiskAgents(agentIds: readonly AgentId[]) {
    const agents = agentIds.flatMap(agentId => {
        const core = getAgentCore(agentId);
        return core ? [{ agentId, title: t(core.displayNameKey), capability: core.connectedServices?.providerStateSharing }] : [];
    });
    const riskIds = new Set(readProviderStateSharingRiskAgentIdsV1(agents));
    return agents.filter(agent => riskIds.has(agent.agentId));
}

/** The rendered control and Actions share the human consent decision, then replay only its admitted intent. */
export async function prepareDefaultProviderStateSharingChange(
    settings: ConnectedServicesProviderStateSharingSettingsV1,
    shared: boolean,
    agentIds: readonly AgentId[] = resolveProviderStateSharingAgentIds(),
): Promise<ProviderStateSharingSettingsMutation | null> {
    const result = await prepareDefaultProviderStateSharingChangeV1(settings, shared, {
        readProviderStateSharingRiskAgentIds: () => sharedStateRiskAgents(agentIds).map(entry => entry.agentId),
        confirmProviderStateSharingRiskAgents: async ids => await Modal.confirm(
            t('connectedServices.providerStateSharing.sharedStatePrivacyTitle'),
            t('connectedServices.providerStateSharing.sharedStatePrivacyBody', {
                agent: sharedStateRiskAgents(agentIds).filter(entry => ids.includes(entry.agentId)).map(entry => entry.title).join(', '),
            }),
            { confirmText: t('common.continue'), destructive: false },
        ),
    });
    return result.status === 'prepared' ? result.mutate : null;
}

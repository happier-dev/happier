import type { AccountProfile, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { AGENT_IDS, getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { DirectBrowseLinkEnsureRequestExtras, DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import type { Settings } from '@/sync/domains/settings/settings';

export function resolveDirectBrowseSourceOptions(params: Readonly<{
    providerId: DirectSessionsProviderId;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
}>): DirectBrowseSourceOption[] {
    const getSourceOptions = getAgentBehavior(params.providerId as AgentId).directSessions?.browse?.getSourceOptions;
    if (!getSourceOptions) return [];
    return [...getSourceOptions({
        agentId: params.providerId as AgentId,
        profile: params.profile,
        settings: params.settings as Settings,
    })];
}

export function listDirectBrowseProviderIds(): DirectSessionsProviderId[] {
    return AGENT_IDS
        .filter((agentId) => (
            getAgentCore(agentId).sessionStorage.direct === true
            && typeof getAgentBehavior(agentId).directSessions?.browse?.getSourceOptions === 'function'
        ))
        .sort((a, b) => {
            const orderA = getAgentBehavior(a).directSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            const orderB = getAgentBehavior(b).directSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            return getAgentCore(a).displayNameKey.localeCompare(getAgentCore(b).displayNameKey);
        }) as DirectSessionsProviderId[];
}

export function resolveDirectBrowseLinkEnsureRequestExtras(params: Readonly<{
    providerId: DirectSessionsProviderId;
    source: DirectSessionsSource;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): DirectBrowseLinkEnsureRequestExtras {
    const buildExtras = getAgentBehavior(params.providerId as AgentId).directSessions?.browse?.buildLinkEnsureRequestExtras;
    if (!buildExtras) return {};
    return buildExtras({
        agentId: params.providerId as AgentId,
        source: params.source,
        candidate: params.candidate,
    });
}

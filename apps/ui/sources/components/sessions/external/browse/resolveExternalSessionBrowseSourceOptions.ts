import type { AccountProfile, ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { AGENT_IDS, getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { ExternalSessionBrowseLinkEnsureRequestExtras, ExternalSessionBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveCompatibleExternalSessionBrowseLinkSource } from './resolveCompatibleExternalSessionBrowseLinkSource';

export function resolveExternalSessionBrowseSourceOptions(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
}>): ExternalSessionBrowseSourceOption[] {
    const getSourceOptions = getAgentBehavior(params.providerId as AgentId).externalSessions?.browse?.getSourceOptions;
    if (!getSourceOptions) return [];
    return [...getSourceOptions({
        agentId: params.providerId as AgentId,
        profile: params.profile,
        settings: params.settings as Settings,
    })];
}

export function listExternalSessionBrowseProviderIds(): ExternalSessionsAgentId[] {
    return AGENT_IDS
        .filter((agentId) => (
            getAgentCore(agentId).sessionStorage.direct === true
            && typeof getAgentBehavior(agentId).externalSessions?.browse?.getSourceOptions === 'function'
        ))
        .sort((a, b) => {
            const orderA = getAgentBehavior(a).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            const orderB = getAgentBehavior(b).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            return getAgentCore(a).displayNameKey.localeCompare(getAgentCore(b).displayNameKey);
        }) as ExternalSessionsAgentId[];
}

export function resolveExternalSessionBrowseLinkEnsureRequestExtras(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): ExternalSessionBrowseLinkEnsureRequestExtras {
    const buildExtras = getAgentBehavior(params.providerId as AgentId).externalSessions?.browse?.buildLinkEnsureRequestExtras;
    if (!buildExtras) return {};
    return buildExtras({
        agentId: params.providerId as AgentId,
        source: params.source,
        candidate: params.candidate,
    });
}

export function resolveExternalSessionBrowseCompatibleLinkSource(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    selectedSource: ExternalSessionsSource;
    candidateSource?: ExternalSessionsSource | null;
}>): ExternalSessionsSource {
    const resolveCompatibleLinkSource = getAgentBehavior(params.providerId as AgentId).externalSessions?.browse?.resolveCompatibleLinkSource;
    return resolveCompatibleExternalSessionBrowseLinkSource({
        selectedSource: params.selectedSource,
        candidateSource: params.candidateSource,
        ...(resolveCompatibleLinkSource
            ? {
                resolveCompatibleLinkSource: (ctx) => resolveCompatibleLinkSource({
                    agentId: params.providerId as AgentId,
                    selectedSource: ctx.selectedSource,
                    candidateSource: ctx.candidateSource,
                }),
            }
            : {}),
    });
}

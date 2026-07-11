import type { AccountProfile, ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

import { resolveExternalSessionBrowseSourceOptions } from './resolveExternalSessionBrowseSourceOptions';

export function canBrowseExternalSessions(agentId: AgentId): boolean {
    return getAgentCore(agentId).sessionStorage.direct === true
        && typeof getAgentBehavior(agentId).externalSessions?.browse?.getSourceOptions === 'function';
}

export function resolveExternalSessionBrowseLockedSource(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    agentOptionState?: Record<string, unknown> | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
}>): ExternalSessionsSource | null {
    const sourceOptions = resolveExternalSessionBrowseSourceOptions({
        providerId: params.providerId,
        profile: params.profile,
        settings: params.settings,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = getAgentBehavior(params.providerId as unknown as AgentId).externalSessions?.browse?.resolveLockedSourceOption;
    const resolvedOption = resolver
        ? resolver({
            agentId: params.providerId as unknown as AgentId,
            sourceOptions,
            agentOptionState: params.agentOptionState ?? null,
            profile: params.profile,
            settings: params.settings as Settings,
        })
        : null;

    return (resolvedOption ?? sourceOptions[0])?.source ?? null;
}

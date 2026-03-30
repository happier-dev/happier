import type { AccountProfile, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { getAgentBehavior, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';

import { resolveDirectBrowseSourceOptions } from './resolveDirectBrowseSourceOptions';

export function canBrowseDirectSessions(agentId: AgentId): boolean {
    return getAgentCore(agentId).sessionStorage.direct === true
        && typeof getAgentBehavior(agentId).directSessions?.browse?.getSourceOptions === 'function';
}

export function resolveDirectBrowseLockedSource(params: Readonly<{
    providerId: DirectSessionsProviderId;
    agentOptionState?: Record<string, unknown> | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
}>): DirectSessionsSource | null {
    const sourceOptions = resolveDirectBrowseSourceOptions({
        providerId: params.providerId,
        profile: params.profile,
        settings: params.settings,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = getAgentBehavior(params.providerId as unknown as AgentId).directSessions?.browse?.resolveLockedSourceOption;
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

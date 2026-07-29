import type {
    AccountProfile,
    ExternalSessionsAgentId,
    ExternalSessionsSource,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type { Settings } from '@/sync/domains/settings/settings';

import {
    listExternalSessionBrowseProviderIds,
    resolveExternalSessionBrowseSourceOptions,
} from './resolveExternalSessionBrowseSourceOptions';

export function canBrowseExternalSessions(params: Readonly<{
    agentId: ExternalSessionsAgentId;
    projection: PluginProjectionV2 | null | undefined;
}>): boolean {
    return listExternalSessionBrowseProviderIds({ projection: params.projection }).includes(params.agentId);
}

export function resolveExternalSessionBrowseLockedSource(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    agentOptionState?: Record<string, unknown> | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    projection: PluginProjectionV2 | null | undefined;
}>): ExternalSessionsSource | null {
    const sourceOptions = resolveExternalSessionBrowseSourceOptions({
        providerId: params.providerId,
        profile: params.profile,
        settings: params.settings,
        projection: params.projection,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = resolveAgentUiBehavior(params.providerId).externalSessions?.browse?.resolveLockedSourceOption;
    const resolvedOption = resolver
        ? resolver({
            agentId: params.providerId,
            sourceOptions,
            agentOptionState: params.agentOptionState ?? null,
            profile: params.profile,
            settings: params.settings as Settings,
        })
        : null;

    return (resolvedOption ?? sourceOptions[0])?.source ?? null;
}

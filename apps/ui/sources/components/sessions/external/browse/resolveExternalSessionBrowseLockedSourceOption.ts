import type {
    AccountProfile,
    ExternalSessionsAgentId,
    ExternalSessionsSource,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ExternalSessionBrowseLabels } from './resolveExternalSessionBrowseSourceOptions';

import {
    listExternalSessionBrowseProviderIds,
    resolveExternalSessionBrowseSourceOptions,
} from './resolveExternalSessionBrowseSourceOptions';

export function canBrowseExternalSessions(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    agentId: ExternalSessionsAgentId;
    projection: PluginProjectionV2 | null | undefined;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    /**
     * The interaction the caller is about to offer. A resume-only source (ACP
     * `session/list`: enumerate candidates to resume in Happier, with no link
     * identity and no takeover/follow claim) is reachable only from
     * `pickRemoteSessionId`, so a picker entry point that omits this would
     * silently exclude the Agent it is trying to browse.
     */
    interaction?: 'openSession' | 'pickRemoteSessionId';
}>): boolean {
    return listExternalSessionBrowseProviderIds({
        accountScope: params.accountScope,
        projection: params.projection,
        machineId: params.machineId,
        interaction: params.interaction,
    }).includes(params.agentId);
}

export function resolveExternalSessionBrowseLockedSource(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    providerId: ExternalSessionsAgentId;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    agentOptionState?: Record<string, unknown> | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    labelsByKey: ExternalSessionBrowseLabels;
    agentSettings?: Readonly<Record<string, unknown>>;
    projection: PluginProjectionV2 | null | undefined;
    /** See `canBrowseExternalSessions`. */
    interaction?: 'openSession' | 'pickRemoteSessionId';
}>): ExternalSessionsSource | null {
    const sourceOptions = resolveExternalSessionBrowseSourceOptions({
        accountScope: params.accountScope,
        providerId: params.providerId,
        machineId: params.machineId,
        profile: params.profile,
        labelsByKey: params.labelsByKey,
        agentSettings: params.agentSettings,
        projection: params.projection,
        interaction: params.interaction,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = resolveAgentUiBehavior(params.providerId, params.machineId, params.accountScope)
        .externalSessions?.browse?.resolveLockedSourceOption;
    const resolvedOption = resolver
        ? resolver({
            agentId: params.providerId,
            sourceOptions,
            agentOptionState: params.agentOptionState ?? null,
            profile: params.profile,
        })
        : null;

    return (resolvedOption ?? sourceOptions[0])?.source ?? null;
}

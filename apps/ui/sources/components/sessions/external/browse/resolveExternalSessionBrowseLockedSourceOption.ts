import type {
    AccountProfile} from '@happier-dev/protocol/account/profile';
import type {
    ExternalSessionsAgentId,
    ExternalSessionsSource} from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type {
    PluginProjectionV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
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
    accountScope: ServerAccountScope | null;
    serverId: string | null;
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
    // All browse projection readers bind an omitted Home to the captured active
    // Account. Preserve that target meaning without reading another global scope.
    const targetServerId = params.serverId ?? params.accountScope?.serverId ?? null;
    const accountScope = selectActiveServerAccountScopeForServer(params.accountScope, targetServerId);
    const accountInputsAvailable = accountScope !== null;
    const profile = accountInputsAvailable ? params.profile : null;
    const sourceOptions = resolveExternalSessionBrowseSourceOptions({
        accountScope,
        providerId: params.providerId,
        machineId: params.machineId,
        profile,
        labelsByKey: accountInputsAvailable ? params.labelsByKey : {},
        agentSettings: accountInputsAvailable ? params.agentSettings : undefined,
        projection: params.projection,
        interaction: params.interaction,
    });
    if (sourceOptions.length === 0) return null;

    const resolver = resolveAgentUiBehavior(params.providerId, params.machineId, accountScope)
        .externalSessions?.browse?.resolveLockedSourceOption;
    const resolvedOption = resolver
        ? resolver({
            agentId: params.providerId,
            sourceOptions,
            agentOptionState: accountInputsAvailable ? params.agentOptionState ?? null : null,
            profile,
        })
        : null;

    return (resolvedOption ?? sourceOptions[0])?.source ?? null;
}

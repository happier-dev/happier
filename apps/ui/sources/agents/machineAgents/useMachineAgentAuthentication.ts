import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storage';
import { loadAccountProfile } from '@/sync/domains/state/accountProfilePersistence';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveConnectedServiceRegistryEntryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import type { DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { projectMachineAgentAuthentication } from './machineAgentAuthentication';

/** Scoped Account inputs for both detailed inventory and passive fleet summaries. No Machine probes. */
export function useMachineAgentAuthentication(input: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    serverId: string;
    enabled: boolean;
    sourceMachineId?: string;
}>) {
    const { lifetime, serverId, enabled } = input;
    const profileSlice = getStorage()(useShallow(state => ({ scope: state.profileScope,
        connectedServicesV2: state.profile.connectedServicesV2, connectedAccountsV4: state.profile.connectedAccountsV4,
        connectedAccountGroupsV4: state.profile.connectedAccountGroupsV4 })));
    const savedProfile = React.useMemo(() => lifetime ? loadAccountProfile(lifetime.scope) : profileDefaults, [lifetime]);
    const profile = lifetime && areServerAccountScopesEqual(profileSlice.scope, lifetime.scope) ? profileSlice : savedProfile;
    const purposeCatalog = useConnectedAccountCatalog('purposes', enabled ? lifetime?.scope ?? null : null,
        { sourceMachineId: input.sourceMachineId });
    const liveFeatures = useServerFeaturesSnapshotForServerId(serverId, { enabled });
    // Every producer of one Machine inventory must evaluate the same Account fact. The imperative reader
    // (`readMachineAgentAuthentication`) uses the settled cache; a mounted observer whose own snapshot is
    // still loading (disabled, or one render behind enabling) must not publish an undetermined Connected
    // Account shape over it, which the next publication reverses and re-renders every consumer.
    const features = liveFeatures.status === 'loading' ? getCachedServerFeaturesSnapshot({ serverId }) ?? liveFeatures : liveFeatures;
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups', { scopeKind: 'spawn', serverId });
    const localize = useProjectedPluginLocalizedTextResolver();
    const { present } = useConnectedAccountIdentityPrivacy();
    const teamCatalog = useHomeTeamCredentialModelCatalog({ serverId,
        machineId: input.sourceMachineId,
        enabled: enabled && Boolean(purposeCatalog.value?.teamResourceSelections?.length) });
    const teamCredentialResources = teamCatalog.current ? teamCatalog.resources : undefined;
    return React.useCallback((projection: DaemonMergedProjectionInputsState) => projectMachineAgentAuthentication({
        projection, scope: lifetime?.scope ?? null, profile, purposeBindings: purposeCatalog.value, features,
        accountGroupsEnabled, teamCredentialResources,
        titleForService: entry => resolveConnectedServiceRegistryEntryDisplayName(entry, t, localize), presentIdentity: present,
    }), [accountGroupsEnabled, features, lifetime, localize, present, profile, purposeCatalog.value, teamCredentialResources]);
}

import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import { getStorage } from '@/sync/domains/state/storage';
import { loadAccountProfile } from '@/sync/domains/state/accountProfilePersistence';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { mergeConnectedAccountDescriptorProjections } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { projectConnectedServiceRegistryEntries } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedServiceRegistryEntryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { buildQualifiedConnectedAccountGroupOptionsByServiceId, resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import type { DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { MachineAgentInventoryObservation } from './machineAgentInventoryStore';
import { projectMachineAgentConnectedServices } from './machineAgentConnectedServices';

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
    const features = useServerFeaturesSnapshotForServerId(serverId, { enabled });
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups', { scopeKind: 'spawn', serverId });
    const localize = useProjectedPluginLocalizedTextResolver();
    const { present } = useConnectedAccountIdentityPrivacy();
    const teamCatalog = useHomeTeamCredentialModelCatalog({ serverId,
        machineId: input.sourceMachineId,
        enabled: enabled && Boolean(purposeCatalog.value?.teamResourceSelections?.length) });
    const teamCredentialResources = teamCatalog.current ? teamCatalog.resources : undefined;
    return React.useCallback((projection: DaemonMergedProjectionInputsState): Pick<MachineAgentInventoryObservation,
        'connectedServicesByAgentId' | 'credentialSelectionsByAgentId'> => {
        // A lost Machine projection leaves last-known authentication intact; it does not select native.
        if (!projection.inputs) return {};
        const agents = Object.entries(projection.inputs.mergedProviderProjectionById);
        const descriptors = projection.inputs.connectedAccountProjection;
        const resolution = mergeConnectedAccountDescriptorProjections(descriptors ? [descriptors] : []);
        const entries = resolution.kind === 'error' ? [] : projectConnectedServiceRegistryEntries({
            scopeKey: lifetime ? JSON.stringify(lifetime.scope) : '', status: resolution.kind,
            descriptors: resolution.descriptors, conflicts: resolution.conflicts, errorReason: null,
        });
        const groupOptionsByServiceId = buildQualifiedConnectedAccountGroupOptionsByServiceId({
            groups: profile.connectedAccountGroupsV4,
            supportedServiceIds: resolveProjectedConnectedAccountServiceKeys(agents.flatMap(([, agent]) => agent.connectedAccounts ?? [])),
        });
        const connectedServicesByAgentId = projectMachineAgentConnectedServices({
            agents: agents.map(([agentId, agent]) => ({ agentId, connectedAccounts: agent.connectedAccounts ?? undefined })),
            profile, accountTransport: resolveConnectedAccountUiNegotiation(features), entries, now: Date.now(),
            titleForService: entry => resolveConnectedServiceRegistryEntryDisplayName(entry, t, localize),
            presentIdentity: present, groupOptionsByServiceId: accountGroupsEnabled ? groupOptionsByServiceId : {},
        });
        const credentialSelectionsByAgentId = Object.fromEntries(agents.map(([agentId, agent]) => {
            const declarations = agent.connectedAccounts ?? [];
            const credentialBindings = agent.identity && purposeCatalog.value
                ? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(resolveAgentConnectedAccountPurposeDefaults({
                    settings: {}, purposeBindings: purposeCatalog.value, agentId, consumer: agent.identity, declarations,
                })) : null;
            const usesTeamResource = Object.values(credentialBindings?.bindingsByServiceId ?? {}).some(binding => binding.source === 'team_resource');
            return [agentId, {
                credentialBindings,
                // Retained admitted defaults remain useful while refreshing; withdrawn/unread defaults do not imply native.
                credentialBindingsReady: (declarations.length === 0 || Boolean(agent.identity && purposeCatalog.value))
                    && (!usesTeamResource || teamCredentialResources !== undefined),
                groupOptionsByServiceId, teamCredentialResources,
            }];
        }));
        return { connectedServicesByAgentId, credentialSelectionsByAgentId };
    }, [accountGroupsEnabled, features, lifetime, localize, present, profile, purposeCatalog.value, teamCredentialResources]);
}

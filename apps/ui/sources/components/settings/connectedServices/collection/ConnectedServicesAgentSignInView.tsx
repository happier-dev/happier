import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol/account/settings/connected-services';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingSection } from '@/components/settings/shell/SettingRow';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { Modal } from '@/modal';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { canExecuteConnectedServiceAction, getLegacyConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useActiveServerAccountScope, useSettingMutable, useSettingsSelector } from '@/sync/store/hooks';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { selectConnectedMetadataAcknowledgements, selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { setConnectedAcknowledgement } from '@/sync/api/account/apiConnectedMetadataCatalog';
import type { QualifiedAcknowledgementSubject } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { t } from '@/text';

import {
    ConnectedServicesDefaultAuthRow,
} from '../ConnectedServicesDefaultAuthRow';
import { ConnectedServicesProviderStateSharingDisclosure } from '../ConnectedServicesProviderStateSharingSettings';
import { CONNECTED_SERVICES_SETTINGS } from '../connectedServicesSettings';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';

/**
 * How agents sign in (the rail's foot): which account, pool or own login each agent signs in with when
 * a session starts, and what connected-account sessions share with the agent's own sign-in. Defaults
 * are per agent; the ★ on accounts and pools writes the same defaults.
 */
export const ConnectedServicesAgentSignInView = React.memo(function ConnectedServicesAgentSignInView() {
    const router = useRouter();
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope(activeServer.serverId);
    const index = useConnectedServicesIndex({ agents: 'load' });
    const { agentEntries, qualifiedAccounts, qualifiedGroups } = index;
    const settings = useSettingsSelector((settings) => ({
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    }));
    const labelsByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataLabels);
    const poolAdoptionDismissedByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataAcknowledgements);
    const { catalog: purposeCatalog, legacySettings, mutateDefaults } = useConnectedAccountPurposeDefaults();
    const [providerStateSharingSettings, setProviderStateSharingSettings] =
        useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
    const normalizedProviderStateSharingSettings = React.useMemo(
        () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
        [providerStateSharingSettings],
    );
    const dismissPoolAdoptionSuggestion = React.useCallback(async (subject: Extract<QualifiedAcknowledgementSubject, { kind: 'adoption' }>) => {
        if (!activeAccountScope) return false;
        try { await setConnectedAcknowledgement({ subject, acknowledged: true }, activeAccountScope); return true; }
        catch { return false; }
    }, [activeAccountScope]);
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: activeAccountScope?.serverId,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: activeAccountScope?.serverId,
        enabled: teamCredentialResourcesEnabled,
    });

    /** Released V2/V3 default-auth ingress uses the same action admission as the index. */
    const openLegacyConnectedServiceSettings = React.useCallback(async (serviceId: string) => {
        const entry = getLegacyConnectedServiceRegistryEntry(serviceId);
        if (!entry.service || !canExecuteConnectedServiceAction(entry, index.transport)) {
            await Modal.alert(t('errors.daemonUnavailableTitle'), t('errors.daemonUnavailableBody'));
            return;
        }
        router.push(buildConnectedAccountSettingsRoute(entry.service, null, { add: true }));
    }, [index.transport, router]);

    return (
        <ItemList>
            <SettingsPageHeader
                title={t('connectedServicesCollection.agentSignInTitle')}
                description={t('connectedServicesSettings.usageDescription')}
                alwaysShowTitle
            />
            <SettingSection section={CONNECTED_SERVICES_SETTINGS.sectionRefs.usage}>
                <ItemGroup title={t('connectedServicesSettings.agentDefaultsTitle')} description={t('connectedServicesSettings.agentDefaultsDescription')}>
                    {agentEntries.filter((agentEntry) => agentEntry.connectedAccounts.length > 0).map((agentEntry, agentIndex) => (
                        <ConnectedServicesDefaultAuthRow
                            key={`${activeAccountScope?.serverId}:${activeAccountScope?.accountId}:${agentEntry.agentId}`}
                            // Search reaches the per-agent default sign-in rows through the first of them.
                            setting={agentIndex === 0 ? CONNECTED_SERVICES_SETTINGS.settings.agentDefaults : undefined}
                            agentId={agentEntry.agentId}
                            machineId={index.appShellProjection.machineId ?? undefined}
                            agentIdentity={agentEntry.identity}
                            agentTitle={agentEntry.title}
                            connectedAccountPurposes={agentEntry.connectedAccounts}
                            connectedAccountServiceKeys={agentEntry.connectedAccounts.map((declaration) => (
                                buildQualifiedPluginContributionKey(declaration.service)
                            ))}
                            connectedAccountsV4={qualifiedAccounts}
                            connectedAccountGroupsV4={qualifiedGroups}
                            accountGroupsEnabled={accountGroupsEnabled}
                            purposeBindings={purposeCatalog.value}
                            purposeBindingsWritable={purposeCatalog.status === 'ready' && !purposeCatalog.stale}
                            purposeBindingsLoading={purposeCatalog.status === 'loading'}
                            teamCredentialResources={teamCredentialCatalog.resources}
                            teamNameById={teamCredentialCatalog.teamNameById}
                            currentTeamCredentialResourceKeys={teamCredentialCatalog.currentResourceKeys}
                            onRecoverTeamCredentialResource={(resource) => {
                                if (!activeAccountScope) return;
                                router.push(teamCredentialDetailPath({
                                    serverId: activeAccountScope.serverId,
                                    teamId: resource.teamId,
                                }, resource.id) as never);
                            }}
                            labelsByKey={labelsByKey}
                            settings={{
                                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                                ...legacySettings,
                            }}
                            setDefaultAuthSettings={mutateDefaults}
                            onOpenConnectedServicesSettings={openLegacyConnectedServiceSettings}
                            dismissedPoolAdoptionSuggestionKeys={poolAdoptionDismissedByKey}
                            onDismissPoolAdoptionSuggestion={dismissPoolAdoptionSuggestion}
                        />
                    ))}
                </ItemGroup>
                <ItemGroup title={t('connectedServicesSettings.sharingTitle')}>
                    <ConnectedServicesProviderStateSharingDisclosure
                        settings={normalizedProviderStateSharingSettings}
                        setSettings={setProviderStateSharingSettings}
                        onOpenBackendOverrides={() => router.push('/(app)/settings/connected-services/provider-state-sharing')}
                    />
                </ItemGroup>
            </SettingSection>
        </ItemList>
    );
});

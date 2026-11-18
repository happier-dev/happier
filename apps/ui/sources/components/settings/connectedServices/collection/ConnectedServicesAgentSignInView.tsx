import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol/account/settings/connected-services';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingSection } from '@/components/settings/shell/SettingRow';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { Modal } from '@/modal';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { ConnectedAccountSettled } from '../setup/ConnectedAccountSettled';
import type { ConnectedAccountSetupCompletion } from '../account/useConnectedAccountSetupCompletion';
import { canExecuteConnectedServiceAction, getLegacyConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useActiveServerAccountScope, useSetting } from '@/sync/store/hooks';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { selectConnectedMetadataAcknowledgements, selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import type { QualifiedAcknowledgementSubject } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ConnectedMetadataCatalogSnapshot } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';

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
const NO_DISMISSED_GUIDANCE: readonly never[] = Object.freeze([]);
const selectAcknowledgementsRecord = (snapshot: ConnectedMetadataCatalogSnapshot) => snapshot.acknowledgements;

export const ConnectedServicesAgentSignInView = React.memo(function ConnectedServicesAgentSignInView() {
    const router = useRouter();
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope(activeServer.serverId);
    const acknowledgementExecution = useMountedActionExecution(activeAccountScope);
    const index = useConnectedServicesIndex({ agents: 'load' });
    const [settled, setSettled] = React.useState<ConnectedAccountSetupCompletion | null>(null);
    const { agentEntries, qualifiedAccounts, qualifiedGroups } = index;
    const settings = useSettingsValues(['connectedServicesDefaultProfileByServiceId']);
    const labelsByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataLabels);
    const poolAdoptionDismissedByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataAcknowledgements);
    const acknowledgements = useConnectedMetadataCatalog(activeAccountScope, selectAcknowledgementsRecord);
    const dismissedGuidance = React.useMemo(() => acknowledgements.status === 'ready' || acknowledgements.status === 'partial'
        ? acknowledgements.entries.filter(entry => entry.acknowledged) : NO_DISMISSED_GUIDANCE, [acknowledgements]);
    // One reset per dismissed subject, in turn: each is a revisioned write to the same Account row.
    const showGuidanceAgain = React.useCallback(() => {
        fireAndForget((async () => {
            for (const entry of dismissedGuidance) {
                const result = await acknowledgementExecution.execute('connectedServices.acknowledgements.reset', { subject: entry.subject });
                if (!result.ok) return;
            }
        })(), { tag: 'ConnectedServicesAgentSignInView.showGuidanceAgain' });
    }, [acknowledgementExecution.execute, dismissedGuidance]);
    const { catalog: purposeCatalog, legacySettings, mutateDefaults, execution: purposeExecution } = useConnectedAccountPurposeDefaults();
    const providerStateSharingSettings = useSetting('connectedServicesProviderStateSharingSettingsV1');
    const normalizedProviderStateSharingSettings = React.useMemo(
        () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
        [providerStateSharingSettings],
    );
    const dismissPoolAdoptionSuggestion = React.useCallback(async (subject: Extract<QualifiedAcknowledgementSubject, { kind: 'adoption' }>) => {
        if (!activeAccountScope) return false;
        try {
            const result = await acknowledgementExecution.execute('connectedServices.acknowledgements.set', { subject, acknowledged: true });
            return result.ok;
        }
        catch { return false; }
    }, [acknowledgementExecution.execute, activeAccountScope]);
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: activeAccountScope?.serverId,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: activeAccountScope?.serverId,
        machineId: null,
        enabled: teamCredentialResourcesEnabled,
    });

    /** Released V2/V3 default-auth ingress uses the same action admission as the index. */
    const openLegacyConnectedServiceSettings = React.useCallback(async (serviceId: string) => {
        const entry = getLegacyConnectedServiceRegistryEntry(serviceId);
        if (!entry.service || !canExecuteConnectedServiceAction(entry, index.transport)) {
            await Modal.alert(t('errors.daemonUnavailableTitle'), t('errors.daemonUnavailableBody'));
            return;
        }
        const result = await presentConnectSheet({ scope: activeAccountScope, service: entry.service, intent: 'link' });
        if (result.kind !== 'dismissed') setSettled(result);
    }, [activeAccountScope, index.transport]);

    return (
        <ItemList>
            <ConnectedAccountActionApprovalNotice execution={acknowledgementExecution} testID="connected-services-acknowledgement-approval-pending" />
            <ConnectedAccountActionApprovalNotice execution={purposeExecution} testID="connected-services-purpose-approval-pending" />
            <SettingsPageHeader
                title={t('connectedServicesCollection.agentSignInTitle')}
                description={t('connectedServicesSettings.usageDescription')}
                alwaysShowTitle
            />
            {settled ? <ConnectedAccountSettled account={settled.account} completion={settled} model={index.indexModel} agents={agentEntries}
                machineId={index.appShellProjection.machineId ?? undefined} onDismiss={() => setSettled(null)} /> : null}
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
                            teamCredentialDisplayNames={teamCredentialCatalog.displayNames}
                            teamNameById={teamCredentialCatalog.teamNameById}
                            teamCredentialResourceStatusByKey={teamCredentialCatalog.resourceStatusByKey}
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
                    {dismissedGuidance.length > 0 ? (
                        <Item
                            testID="connected-services-agent-sign-in:show-guidance-again"
                            title={t('connectedServicesCollection.showGuidanceAgain')}
                            showChevron={false}
                            onPress={showGuidanceAgain}
                        />
                    ) : null}
                </ItemGroup>
                <ItemGroup title={t('connectedServicesSettings.sharingTitle')}>
                    <ConnectedServicesProviderStateSharingDisclosure
                        settings={normalizedProviderStateSharingSettings}
                        onOpenBackendOverrides={() => router.push('/(app)/settings/connected-services/provider-state-sharing')}
                    />
                </ItemGroup>
            </SettingSection>
        </ItemList>
    );
});

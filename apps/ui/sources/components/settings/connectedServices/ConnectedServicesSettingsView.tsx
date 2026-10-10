import { ProviderUsageGaugeSettingsGroup } from './ProviderUsageGaugeSettingsGroup';
import { CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS } from './connectedServicesSettings';
import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { TeamCredentialCatalogSettingsGroup } from '@/components/settings/teams/credentials/TeamCredentialCatalogSettingsGroup';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useUsageSummary } from '@/components/hub/usage/useUsageSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute, buildNewConnectedAccountPoolRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { useActiveServerAccountScope, useAllMachines, useLocalSettingMutable } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useDeviceType } from '@/utils/platform/responsive';

import { AgentDefaultMenuButton } from './defaults/AgentDefaultMenuButton';
import { ConnectedAccountPrivacyToggle } from './usage/ConnectedAccountPrivacyToggle';
import { buildAgentDefaultChoices } from './defaults/agentDefaultChoices';
import { ConnectedAccountIndexLiveFacts } from './index/ConnectedAccountIndexRow';
import { ConnectedServicePoolIndexItem } from './index/ConnectedServicePoolIndexItem';
import { ConnectedServicesGatewaysGroup } from './index/ConnectedServicesGatewaysGroup';
import { ConnectedServicesIndexView, type ConnectedServicesIndexPresentation } from './index/ConnectedServicesIndexView';
import { NewPoolMenu, selectNewPoolServices } from './collection/NewPoolMenu';
import { presentConnectedServiceRegistryReadFailure } from './model/presentConnectedServiceIndexDiagnostics';
import type { ConnectedServicesIndexSheet } from './model/buildConnectedServicesIndexModel';
import { useConnectedServicesIndex } from './model/useConnectedServicesIndex';
import { ConnectedAccountSettled } from './setup/ConnectedAccountSettled';
import { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';
import type { ConnectedServiceSetupTarget } from './setup/ConnectedServiceSetupPanel';
import { readConnectedServiceSetupResult } from './setup/connectMoreBlocks';


/**
 * Connected services, the collection's index (lab `csvc` C1/C2, P0): every service with its accounts
 * and their limits, as a list or as cards; the set-up blocks for what your agents could also use; the
 * pools; Team-shared accounts. With nothing connected yet it is the first run (the promise and the
 * set-up blocks, no rail). Accounts, pools and usage are Account-level; only adding and signing in run
 * on a machine.
 */
export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const router = useRouter();
  const activeServer = useActiveServerSnapshot();
  const activeAccountScope = useActiveServerAccountScope(activeServer.serverId);
  const providersEnabled = useFeatureEnabled('providers');
  const index = useConnectedServicesIndex({ agents: 'load', gateways: providersEnabled });
  const { indexModel, agentEntries, agentsKnown, registrySnapshot, appShellProjection } = index;
  const { catalog: purposeCatalog, legacySettings, mutateDefaults } = useConnectedAccountPurposeDefaults();
  const labelsByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataLabels);
  const privacy = useConnectedAccountIdentityPrivacy();
  const [presentationSetting, setPresentation] = useLocalSettingMutable('connectedServicesIndexViewV1');
  const presentation: ConnectedServicesIndexPresentation = presentationSetting === 'grid' ? 'grid' : 'list';
  const layout = useHappierCollectionLayout();
  const phone = useDeviceType() === 'phone';
  const compact = phone || layout?.mode === 'stacked';
  // "As of": when the usage the rows show was read (the one usage owner; never starts a read itself).
  const usage = useUsageSummary({ load: 'cache' });

  // The rail's "+" (and a service route's `connect`) open the set-up blocks on the catalog.
  const params = useLocalSearchParams<{ connect?: string; service?: string; connectedService?: string; connectedAccount?: string }>();
  const [request, setRequest] = React.useState<ConnectedServiceSetupTarget | null>(null);
  const connectParam = typeof params.connect === 'string' ? params.connect : null;
  const serviceParam = typeof params.service === 'string' ? params.service : null;
  React.useEffect(() => {
    if (!connectParam) return;
    setRequest(serviceParam ? { kind: 'service', serviceKey: serviceParam } : { kind: 'catalog' });
    router.setParams({ connect: undefined, service: undefined });
  }, [connectParam, router, serviceParam]);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [settled, setSettled] = React.useState<Readonly<{ serviceKey: string; account: QualifiedConnectedAccountRef }> | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const connectedServiceParam = params.connectedService;
  const connectedAccountParam = params.connectedAccount;
  React.useEffect(() => {
    if (connectedServiceParam === undefined && connectedAccountParam === undefined) return;
    const result = readConnectedServiceSetupResult({ connectedService: connectedServiceParam, connectedAccount: connectedAccountParam });
    if (result) { setSettled(result); setRefreshToken((current) => current + 1); }
    router.setParams({ connectedService: undefined, connectedAccount: undefined });
  }, [connectedAccountParam, connectedServiceParam, router]);

  const navigate = React.useCallback((href: Parameters<typeof router.push>[0], tag: string) => {
    const result = runGuardedNavigation(() => router.push(href));
    if (result !== true) fireAndForget(result, { tag });
  }, [router]);

  const agents = agentsKnown ? agentEntries : null;
  const renderStar = React.useCallback((target: QualifiedConnectedAccountPurposeBindingTargetV1, testID: string) => {
    if (!agents) return null;
    const choices = purposeCatalog.value
      ? buildAgentDefaultChoices({ agents, settings: legacySettings, purposeBindings: purposeCatalog.value, target })
      : [];
    return (
      <AgentDefaultMenuButton
        testID={testID}
        presentation="icon"
        choices={choices}
        disabledReason={purposeCatalog.status === 'ready' && !purposeCatalog.stale ? undefined
          : t(purposeCatalog.status === 'loading' ? 'common.loading' : 'common.unavailable')}
        onChange={async (agentId, makeDefault) => { await mutateDefaults({ kind: 'target', target, agentId, makeDefault,
          ...(appShellProjection.machineId ? { machineId: appShellProjection.machineId } : {}) }); }}
      />
    );
  }, [agents, appShellProjection.machineId, legacySettings, mutateDefaults, purposeCatalog]);

  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
    scopeKind: 'spawn',
    serverId: activeAccountScope?.serverId,
  });
  const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
    serverId: activeAccountScope?.serverId,
    enabled: teamCredentialResourcesEnabled,
  });

  const machines = useAllMachines();
  const onlineMachineName = React.useMemo(() => {
    const online = machines.find((machine) => isMachineOnline(machine));
    return online ? getMachineDisplayName(online) : null;
  }, [machines]);

  const accountCount = indexModel.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);
  const needsYouCount = indexModel.sheets.reduce((total, sheet) => total
    + sheet.accounts.filter((account) => normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth').length, 0);
  const projectionLoading = registrySnapshot.status === 'loading';
  const projectionFailed = registrySnapshot.status === 'error';
  const projectionReadFailed = projectionFailed || (registrySnapshot.status === 'stale' && registrySnapshot.errorReason !== null);
  const agentConnectable = indexModel.connectable.filter((service) => service.section === 'agents');
  const firstRun = accountCount === 0 && indexModel.sheets.length === 0;

  const banner = projectionReadFailed ? (
    <AttentionBanner
      testID="connected-services-projection-error"
      title={t('connectedServicesSettings.projectionErrorTitle')}
      description={presentConnectedServiceRegistryReadFailure(registrySnapshot.errorReason)}
      action={{
        label: t('common.retry'),
        testID: 'connected-services-projection-retry',
        onPress: () => appShellProjection.reloadConnectedAccountProjection?.(),
      }}
    />
  ) : null;

  const connectMore = (
    <ConnectedServicesConnectMore
      model={indexModel}
      layout={firstRun ? 'firstRun' : 'section'}
      request={request}
      onRequestHandled={() => setRequest(null)}
      onConnected={(account, serviceKey) => setSettled({ serviceKey, account })}
      onOpenChange={setSetupOpen}
      loading={projectionLoading}
    />
  );

  const eye = (
    <ConnectedAccountPrivacyToggle
      testID="connected-services-index:privacy"
      hidden={privacy.hidden}
      onChange={privacy.setHidden}
    />
  );

  if (firstRun) {
    // First run (P0): no rail, the promise and the set-up blocks; nothing to add says why.
    const canAdd = agentConnectable.length > 0 || projectionLoading;
    return (
      <ItemList>
        {!canAdd ? <SettingsPageHeader description={t('settings.connectedServicesSubtitle')} /> : null}
        {banner}
        {canAdd ? <ItemGroup surface="none">{connectMore}</ItemGroup> : !projectionFailed ? (
          <View style={styles.firstRun}>
            <SurfaceStateCard
              testID="connected-services-empty"
              kind="unavailable"
              size="page"
              scene="connectAccount"
              title={t('connectedServicesSettings.emptyTitle')}
              reason={onlineMachineName
                ? t('connectedServicesSettings.emptyNoServiceOnMachine', { machine: onlineMachineName })
                : t('connectedServicesSettings.emptyNoMachineOnline')}
              action={onlineMachineName ? {
                label: t('connectedServicesSettings.emptyOpenAgents'),
                onPress: () => navigate('/(app)/settings/agents', 'ConnectedServices.openAgents'),
              } : {
                label: t('connectedServicesSettings.emptyAction'),
                onPress: () => navigate('/(app)/settings/machines', 'ConnectedServices.openMachines'),
              }}
              note={t('connectedServicesSettings.firstRunMeanwhile')}
            />
          </View>
        ) : null}
        <ProviderUsageGaugeSettingsGroup settings={CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS.settings} />
      </ItemList>
    );
  }

  const openAccount = (sheet: ConnectedServicesIndexSheet, accountId: string) => navigate(
    buildConnectedAccountSettingsRoute(sheet.service, { kind: 'account', accountId }), 'ConnectedServices.openAccount');
  const newPoolServices = selectNewPoolServices(indexModel);

  return (
    <ConnectedServicesIndexView
      model={indexModel}
      labelsByKey={labelsByKey}
      present={privacy.present}
      now={Date.now()}
      presentation={presentation}
      onPresentationChange={setPresentation}
      compact={compact}
      headerActions={(
        <View style={styles.headerActions}>
          {eye}
          <IconButton
            testID="connected-services-index:connect"
            iconName="plus"
            accessibilityLabel={t('connectedServicesCollection.connectService')}
            variant="plain"
            onPress={() => setRequest({ kind: 'catalog' })}
          />
        </View>
      )}
      summary={{
        needsYouCount,
        asOf: usage.asOf,
        onRefreshAll: () => setRefreshToken((token) => token + 1),
      }}
      banner={banner}
      connectMore={connectMore}
      gateways={index.gateways ? (
        <ConnectedServicesGatewaysGroup
          gateways={index.gateways}
          onOpen={(gateway) => navigate(gateway.detailRoute as never, 'ConnectedServices.openGateway')}
        />
      ) : null}
      preferences={<ProviderUsageGaugeSettingsGroup settings={CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS.settings} />}
      sharedWithYou={(
        <TeamCredentialCatalogSettingsGroup
          title={t('teams.credentials.sharedWithYou')}
          sourceKind="connected_service"
          catalog={teamCredentialCatalog}
          onRetry={teamCredentialCatalog.reload}
          onOpen={(resource) => {
            if (!activeAccountScope) return;
            navigate(teamCredentialDetailPath({
              serverId: activeAccountScope.serverId,
              teamId: resource.teamId,
            }, resource.id) as never, 'ConnectedServices.openTeamCredential');
          }}
        />
      )}
      fixProminence={setupOpen ? 'secondary' : 'primary'}
      settled={settled ? {
        serviceKey: settled.serviceKey,
        accountId: settled.account.accountId,
        node: (
          <ConnectedAccountSettled
            account={settled.account}
            model={indexModel}
            agents={agentEntries}
            machineId={appShellProjection.machineId ?? undefined}
            onDismiss={() => setSettled(null)}
          />
        ),
      } : null}
      renderAccount={({ sheet, account, render }) => (
        <ConnectedAccountIndexLiveFacts
          key={account.accountId}
          identity={account.kind === 'qualified'
            ? { kind: 'qualified', account: account.profile.ref }
            : { kind: 'legacy', serviceId: account.legacyServiceId, profileId: account.accountId }}
          status={account.status}
          billedPerUse={account.kind === 'qualified' && account.profile.kind === 'token'}
          showsUsage={sheet.section === 'agents'}
          signedOut={normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth'}
          refreshToken={refreshToken}
          render={render}
        />
      )}
      renderPool={({ sheet, pool, entry, presentation: itemPresentation, showDivider }) => (
        <ConnectedServicePoolIndexItem
          {...entry}
          service={sheet.service}
          presentation={itemPresentation}
          compact={compact}
          showDivider={showDivider}
          key={pool.ref.groupId}
        />
      )}
      renderStar={renderStar}
      onAddAccount={(sheet) => setRequest({ kind: 'service', serviceKey: sheet.serviceKey })}
      onSignInAgain={(sheet, accountId) => setRequest({ kind: 'reconnect', serviceKey: sheet.serviceKey, accountId })}
      onOpenAccount={openAccount}
      onOpenPool={(sheet, groupId) => navigate(
        buildConnectedAccountSettingsRoute(sheet.service, { kind: 'group', groupId }), 'ConnectedServices.openPool')}
      renderNewPool={accountGroupsEnabled && newPoolServices.length > 0 ? (renderTrigger) => (
        <NewPoolMenu
          testID="connected-services-index:new-pool-menu"
          services={newPoolServices}
          onCreate={(sheet) => navigate(buildNewConnectedAccountPoolRoute(sheet.service), 'ConnectedServices.newPool')}
          renderTrigger={renderTrigger}
        />
      ) : null}
    />
  );
});

const styles = StyleSheet.create(() => ({
  firstRun: {
    paddingTop: 18,
    paddingBottom: 12,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
}));

import * as React from 'react';
import { resolveConnectedAccountAccessMode } from './model/resolveConnectedAccountAccessMode';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import { useHappierCollectionIndexView, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { TeamCredentialCatalogSettingsGroup } from '@/components/settings/teams/credentials/TeamCredentialCatalogSettingsGroup';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useUsageSummary } from '@/components/hub/usage/useUsageSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute, buildNewConnectedAccountPoolRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { useActiveServerAccountScope, useLocalSettingMutable, useActiveMachineFacts } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { ConnectedAccountActionApprovalNotice } from './ConnectedAccountActionApprovalNotice';
import { isConnectedAccountSignedOut } from './account/connectedAccountCredentialStatusLabel';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useDeviceType } from '@/utils/platform/responsive';

import { AgentDefaultMenuButton } from './defaults/AgentDefaultMenuButton';
import { ConnectedAccountPrivacyToggle } from './usage/ConnectedAccountPrivacyToggle';
import { buildAgentDefaultChoices } from './defaults/agentDefaultChoices';
import { ConnectedAccountIndexLiveFacts } from './index/ConnectedAccountIndexRow';
import { ConnectedServicePoolIndexItem } from './index/ConnectedServicePoolIndexItem';
import { ConnectedServicesGatewaysGroup, useConnectedServicesGatewaysUnavailable } from './index/ConnectedServicesGatewaysGroup';
import { ConnectedServicesIndexView, type ConnectedServicesIndexPresentation } from './index/ConnectedServicesIndexView';
import { NewPoolMenu, selectNewPoolServices } from './collection/NewPoolMenu';
import { ConnectedServicesAddMenu } from './collection/ConnectedServicesAddMenu';
import { ConnectedServicesRail } from './collection/ConnectedServicesRail';
import { CredentialsSecretsGroup } from './index/CredentialsSecretsGroup';
import { CredentialsComposerGaugesGroup } from './index/CredentialsComposerGaugesGroup';
import { ConnectedServiceMark } from './ConnectedServiceMark';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { resolveConnectedServicesIndexRoot } from './collection/connectedServicesCollectionRoutes';
import type { ConnectedServicesIndexSheet } from './model/buildConnectedServicesIndexModel';
import { useConnectedServicesIndex } from './model/useConnectedServicesIndex';
import { ConnectedAccountSettled } from './setup/ConnectedAccountSettled';
import { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';
import { readConnectedServiceSetupResult } from './setup/connectMoreBlocks';
import { presentConnectSheet, type ConnectSheetAccountRequest } from './setup/ConnectedServiceSetupModal';
import type { PopoverAnchor } from '@/components/ui/popover/_types';


/**
 * Connected services, the collection's index (lab `csvc` C1/C2, P0): every service with its accounts
 * and their limits, as a list or as cards; the set-up blocks for what your agents could also use; the
 * pools; Team-shared accounts. With nothing connected yet it is the first run (the promise and the
 * set-up blocks, no rail). Accounts, pools and usage are Account-level; only adding and signing in run
 * on a machine.
 */
type CredentialsConnectRequest = Pick<ConnectSheetAccountRequest, 'service' | 'account'>;

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView({ connectRequest }: Readonly<{
  connectRequest?: CredentialsConnectRequest;
}> = {}) {
  const presented = useLayoutPresentationActive();
  const [setupOpen, setSetupOpen] = React.useState(false);
  const root = resolveConnectedServicesIndexRoot(useHappierCollectionIndexView(), useLocalSearchParams());
  if (root === 'pending') return null;
  // Where no rail shows, the page is the collection list itself (lab `s2svc:listP`); All services is pushed.
  if (root === 'list' && !setupOpen && !connectRequest) {
    return <RetainedPanelSurface isActive={presented} suspendWhenHidden>
      <ConnectedServicesRail variant="page" />
    </RetainedPanelSurface>;
  }
  // The passive index can park, but a live inline sign-in owns layout-effect
  // cancellation and must remain connected until its existing setup owner closes it.
  return <RetainedPanelSurface isActive={presented} suspendWhenHidden={!setupOpen}>
    <ConnectedServicesSettingsBody setupOpen={setupOpen} onSetupOpenChange={setSetupOpen} connectRequest={connectRequest} />
  </RetainedPanelSurface>;
});

const ConnectedServicesSettingsBody = React.memo(function ConnectedServicesSettingsBody({ setupOpen, onSetupOpenChange: setSetupOpen, connectRequest }: Readonly<{
  setupOpen: boolean;
  connectRequest?: CredentialsConnectRequest;
  onSetupOpenChange: (open: boolean) => void;
}>) {
  const router = useRouter();
  const activeServer = useActiveServerSnapshot();
  const activeAccountScope = useActiveServerAccountScope(activeServer.serverId);
  const providersEnabled = useFeatureEnabled('providers');
  const index = useConnectedServicesIndex({ agents: 'load', gateways: providersEnabled });
  const addGateway = index.addGateway;
  const gatewaysUnavailable = useConnectedServicesGatewaysUnavailable(index.gatewayUnavailable, index.retryGateways);
  const { indexModel, agentEntries, agentsKnown, registrySnapshot, appShellProjection } = index;
  const presented = useLayoutPresentationActive();
  const { catalog: purposeCatalog, legacySettings, mutateDefaults, execution: purposeExecution } = useConnectedAccountPurposeDefaults(undefined, { enabled: presented });
  const labelsByKey = useConnectedMetadataCatalog(activeAccountScope, selectConnectedMetadataLabels);
  const privacy = useConnectedAccountIdentityPrivacy({ mutation: true });
  const [presentationSetting, setPresentation] = useLocalSettingMutable('connectedServicesIndexViewV1');
  const presentation: ConnectedServicesIndexPresentation = presentationSetting === 'grid' ? 'grid' : 'list';
  const layout = useHappierCollectionLayout();
  const phone = useDeviceType() === 'phone';
  const compact = phone || layout?.mode === 'stacked';
  // "As of": when the usage the rows show was read (the one usage owner; never starts a read itself).
  const usage = useUsageSummary({ load: 'cache' });

  // Legacy URLs translate once into the same sheet; desktop Connect more keeps its own inline flow.
  const params = useLocalSearchParams<{ connect?: string; service?: string; connectedService?: string; connectedAccount?: string }>();
  const connectParam = typeof params.connect === 'string' ? params.connect : null;
  const serviceParam = typeof params.service === 'string' ? params.service : null;
  const requestedPluginId = connectRequest?.service?.pluginId;
  const requestedLocalId = connectRequest?.service?.localId;
  const requestedAccountId = connectRequest?.account?.accountId;
  // Route projections may refresh while the sheet is open. Their stable identity,
  // rather than the projection object, owns this one presentation intent.
  const legacyConnectRequest = React.useMemo((): CredentialsConnectRequest | null => {
    if (!requestedPluginId && !connectParam) return null;
    const service = requestedPluginId && requestedLocalId
      ? { pluginId: requestedPluginId, localId: requestedLocalId }
      : parseQualifiedPluginContributionKey(serviceParam);
    if (service) return { service, ...(requestedAccountId ? { account: { service, accountId: requestedAccountId } } : {}) };
    return connectParam && !serviceParam ? {} : null;
  }, [connectParam, requestedAccountId, requestedLocalId, requestedPluginId, serviceParam]);
  const [settled, setSettled] = React.useState<Readonly<{ serviceKey: string; account: QualifiedConnectedAccountRef }> | null>(null);
  const settleAccount = React.useCallback((account: QualifiedConnectedAccountRef) => {
    setSettled({ serviceKey: buildQualifiedPluginContributionKey(account.service), account });
  }, []);
  React.useEffect(() => {
    if (!legacyConnectRequest) return;
    // The presenter captures the active Account lifetime and dismisses on retirement.
    fireAndForget(presentConnectSheet(legacyConnectRequest).then(result => {
      if (result.kind !== 'dismissed') settleAccount(result.account);
    }), { tag: 'ConnectedServices.legacyConnect' });
    if (connectParam) router.setParams({ connect: undefined, service: undefined, view: 'all' });
  }, [connectParam, legacyConnectRequest, router, settleAccount]);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const connectedServiceParam = params.connectedService;
  const connectedAccountParam = params.connectedAccount;
  React.useEffect(() => {
    if (connectedServiceParam === undefined && connectedAccountParam === undefined) return;
    const result = readConnectedServiceSetupResult({ connectedService: connectedServiceParam, connectedAccount: connectedAccountParam });
    if (result) { setSettled(result); setRefreshToken((current) => current + 1); }
    router.setParams({ connectedService: undefined, connectedAccount: undefined });
  }, [connectedAccountParam, connectedServiceParam, router]);

  const navigate = React.useCallback((href: Parameters<typeof router.push>[0] | null, tag: string) => {
    if (!href) return;
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
    machineId: null,
    enabled: teamCredentialResourcesEnabled,
  });

  const accountCount = indexModel.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);
  const needsYouCount = indexModel.sheets.reduce((total, sheet) => total
    + sheet.accounts.filter((account) => isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(account.status))).length, 0);
  const projectionLoading = registrySnapshot.status === 'loading';
  const projectionFailed = registrySnapshot.status === 'error';
  const { registryReadFailure } = index;
  const agentConnectable = indexModel.connectable.filter((service) => service.section === 'agents');
  const hasSharedConnectedServices = teamCredentialCatalog.resources.some((resource) => resource.sourcePresentation?.kind === 'connected_service');
  const firstRun = accountCount === 0 && indexModel.sheets.length === 0 && !hasSharedConnectedServices;

  // Saved accounts keep working, so the read failure is one quiet line with Retry, not an amber box (lab `s2svc:home`).
  const banner = registryReadFailure ? (
    <SurfaceStateCard
      testID="connected-services-projection-error"
      size="line"
      kind="warning"
      title={t('connectedServicesSettings.projectionErrorTitle')}
      reason={registryReadFailure.reason}
      action={{
        label: t('common.retry'),
        testID: 'connected-services-projection-retry',
        onPress: registryReadFailure.retry,
      }}
    />
  ) : null;

  const connectMore = (
    <ConnectedServicesConnectMore
      model={indexModel}
      targetSelection={index.targetSelection}
      layout={firstRun ? 'firstRun' : 'section'}
      onConnected={settleAccount}
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
        <ConnectedAccountActionApprovalNotice execution={purposeExecution} testID="connected-services-default-approval-pending" />
        <ConnectedAccountActionApprovalNotice execution={privacy.execution} testID="connected-services-privacy-approval-pending" />
        {!canAdd ? <SettingsPageHeader description={t('settings.connectedServicesSubtitle')} /> : null}
        {banner}
        {canAdd ? <ItemGroup surface="none">{connectMore}</ItemGroup> : !projectionFailed ? (
          <View style={styles.firstRun}>
            <ConnectedServicesEmptyState navigate={navigate} />
          </View>
        ) : null}
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
          {/* The phone's "+" is the same grouped, searchable menu as the column's (a bottom sheet here). */}
          <ConnectedServicesAddMenu
            testID="connected-services-index:add-menu"
            model={indexModel}
            gatewayFacts={index}
            registryReadFailure={registryReadFailure}
            onOpen={(href) => navigate(href as never, 'ConnectedServices.add')}
            onConnected={settleAccount}
            renderTrigger={(toggle) => (
              <IconButton
                testID="connected-services-index:connect"
                iconName="plus"
                accessibilityLabel={t('connectedServicesCollection.connectService')}
                variant="plain"
                onPress={toggle}
              />
            )}
          />
        </View>
      )}
      summary={{
        needsYouCount,
        asOf: usage.asOf,
        onRefreshAll: () => setRefreshToken((token) => token + 1),
      }}
      banner={<>
        <ConnectedAccountActionApprovalNotice execution={purposeExecution} testID="connected-services-default-approval-pending" />
        <ConnectedAccountActionApprovalNotice execution={privacy.execution} testID="connected-services-privacy-approval-pending" />
        {banner}
      </>}
      connectMore={connectMore}
      // One presentation (crHome A): the overview lists gateways like every other section, beside the rail's.
      // D19: the place stays whenever gateways are on, saying why when they cannot be read.
      gateways={index.gatewaySectionVisible ? (
        <ConnectedServicesGatewaysGroup
          gateways={index.gateways ?? []}
          loading={index.gatewaysLoading}
          unavailable={gatewaysUnavailable}
          onOpen={(gateway) => navigate(gateway.detailRoute as never, 'ConnectedServices.openGateway')}
          onAdd={addGateway ? () => {
            // Opening the shared draft is read-only; Create owns approval and persistence.
            fireAndForget(addGateway().then((route) => {
              if (route) navigate(route as never, 'ConnectedServices.addGateway');
            }), { tag: 'ConnectedServices.addGateway' });
          } : undefined}
        />
      ) : null}
      // Composer gauge preferences live once, with the other usage-limit settings; Credentials leads there.
      composer={<CredentialsComposerGaugesGroup onOpen={() => navigate('/(app)/settings/session/provider-limits' as never, 'ConnectedServices.openUsageGauges')} />}
      secrets={<CredentialsSecretsGroup onOpen={(href) => navigate(href as never, 'ConnectedServices.openSecret')} />}
      onOpenNpmProfiles={() => { fireAndForget(presentConnectSheet({ scope: activeAccountScope,
        service: { kind: 'npm-registry-profile' } }), { tag: 'ConnectedServices.openNpmProfiles' }); }}
      renderAddAccount={(section) => (
        <ConnectedServicesAddMenu
          testID={`connected-services-index:add-${section}`}
          model={indexModel}
          gatewayFacts={index}
          only={section === 'agents' ? AGENT_ADD_CATEGORIES : TOOL_ADD_CATEGORIES}
          label={t(section === 'agents' ? 'connectedServicesCollection.addAgentAccount' : 'connectedServicesCollection.addToolAccount')}
          registryReadFailure={registryReadFailure}
          onOpen={(href) => navigate(href as never, 'ConnectedServices.addFromSection')}
          onConnected={settleAccount}
          renderTrigger={(toggle) => (
            <SectionActionButton
              testID={`connected-services-index:add-${section}:trigger`}
              icon="plus"
              title={t('connectedServicesSettings.addAccount')}
              accessibilityLabel={t(section === 'agents' ? 'connectedServicesCollection.addAgentAccount' : 'connectedServicesCollection.addToolAccount')}
              onPress={toggle}
            />
          )}
        />
      )}
      sharedWithYou={(
        <TeamCredentialCatalogSettingsGroup
          title={t('teams.credentials.sharedWithYou')}
          description={t('connectedServicesCollection.sharedWithYouDescription')}
          surface="none"
          renderMark={(resource) => resource.sourcePresentation?.kind === 'connected_service' ? (
            <ConnectedServiceMark legacyServiceId={readBuiltInLegacyConnectedServiceIdForQualifiedService(resource.sourcePresentation.service)} size="inline" />
          ) : null}
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
          billedPerUse={account.kind === 'qualified' && resolveConnectedAccountAccessMode(account.profile)?.kind === 'apiKey'}
          showsUsage={sheet.section === 'agents'}
          signedOut={isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(account.status))}
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
      onAddAccount={(sheet, anchor?: PopoverAnchor) => {
        fireAndForget(presentConnectSheet({ scope: activeAccountScope, intent: 'add', service: sheet.service,
          ...(anchor ? { anchor } : {}) }).then((result) => {
          if (result.kind !== 'dismissed') settleAccount(result.account);
        }), { tag: 'ConnectedServices.addAccount' });
      }}
      onSignInAgain={(sheet, accountId, anchor?: PopoverAnchor) => {
        fireAndForget(presentConnectSheet({ scope: activeAccountScope, intent: 'reconnect', service: sheet.service, account: { service: sheet.service, accountId },
          ...(anchor ? { anchor } : {}) }).then((result) => {
          if (result.kind !== 'dismissed') settleAccount(result.account);
        }), { tag: 'ConnectedServices.reconnect' });
      }}
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

/** Only the visible empty-state explanation needs live Machine presence, never the saved index or setup flow. */
function ConnectedServicesEmptyState(props: Readonly<{
  navigate: (href: Parameters<ReturnType<typeof useRouter>['push']>[0], tag: string) => void;
}>) {
  return useLayoutPresentationActive() ? <ConnectedServicesEmptyMachineState {...props} /> : null;
}

function ConnectedServicesEmptyMachineState({ navigate }: React.ComponentProps<typeof ConnectedServicesEmptyState>) {
  const scope = useActiveServerAccountScope();
  const machines = useActiveMachineFacts();
  useMachineReachabilityRevision();
  const nowMs = useMachinePresenceNowMs(machines);
  const online = machines.find((machine) => isMachineSelectableForFleet(scope, machine, nowMs));
  const onlineMachineName = online ? getMachineSentenceName(online) : null;
  return <SurfaceStateCard
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
  />;
}

/** A section's "+" offers what that section lists (Agent accounts; Code and tools with cloud machines and plugin services). */
const AGENT_ADD_CATEGORIES = ['agent-sign-in'] as const;
const TOOL_ADD_CATEGORIES = ['code-tools', 'cloud-machines', 'plugins'] as const;

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

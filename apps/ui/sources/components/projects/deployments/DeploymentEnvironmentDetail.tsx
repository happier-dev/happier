import { readDeploymentMoveEligibility, showDeploymentMoveSheet, type DeploymentMoveEligibility } from './DeploymentMoveSheet';
import * as React from 'react';
import { resolveDeploymentSourceMethodV1 } from '@happier-dev/deployments/contracts/v1';
import { isDeploymentDomainAttachedV1, selectDeploymentTargetRemovalChoicesV1 } from '@happier-dev/deployments';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { View } from 'react-native';
import { REVEAL_DELAY_MS, useSettingReveal } from '@/components/settings/shell/SettingRow';
import { DEPLOYMENT_DATABASE_CATALOG_FILTER, ENVIRONMENT_AUTOMATIONS_DESTINATION } from './deploymentNavigation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DeploymentEnvironmentDestinationV1,
  DeploymentEnvironmentSettingsSectionV1,
  DeploymentEnvironmentTabV1,
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentDomainServingUrlV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { DeploymentTelemetryPanel } from './DeploymentTelemetryPanel';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { DeploymentEnvironmentMark } from './rows/DeploymentEnvironmentRow';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DEFAULT_DEPLOYMENT_ON_FAILURE_V1, type DeploymentOnFailureV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { buildSessionListDateGroups, formatDayGroupedAge } from '@/sync/domains/session/listing/sessionListDateGroups';
import { useCollectionConditionHeader } from '@/components/ui/lists/collection/useCollectionConditionHeader';
import {
  createDeploymentHistoryFilterRegistry,
  EMPTY_DEPLOYMENT_HISTORY_FILTER,
  type DeploymentHistoryFilter,
} from './deploymentHistoryFilter';
import { ItemGroup, ItemGroupDefaultSurfaceProvider } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { StatusPill, StatusWord } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  useMachineDisplayNamesById,
  useServerScopedMachine,
} from '@/sync/store/hooks';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { keepNamesWhole } from '@/utils/text/keepNamesWhole';
import { HappyError } from '@/utils/errors/errors';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { DeploymentSecretRequests } from './DeploymentSecretRequests';
import { DeploymentSecretBindingsNotice } from './DeploymentSecretBindingsNotice';
import { showDeploymentCiTokenSheet, type DeploymentCiInput } from './DeploymentCiToken';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { DeploymentContentV1, DeploymentReceiptFailureV1, DeploymentSourceMethodV1, DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';

import {
  deploymentActorIsViewer,
  deploymentActorLabel,
  deploymentDefinitionLabel,
  deploymentDurationMs,
  deploymentReceiptAtMs,
  deploymentHistoryLead,
  deploymentReceiptTitle,
  deploymentRevisionLabel,
  deploymentOperationLabel,
  deploymentSourceLabel,
  deploymentStateLabel,
  deploymentStateNotice,
  deploymentWorkStatus,
  deploymentDeployAvailability,
  deploymentHealthFact,
  deploymentEnvironmentAttention,
  deploymentAttentionLeaves,
  deploymentPreviewAvailability,
  deploymentReadIssue,
} from './deploymentPresentation';
import {
  useDeploymentPress,
  hasDeploymentPressAttention,
  readDeploymentActionError,
  type DeploymentActionOutcome,
  type DeploymentOutcomeController,
  type DeploymentRecoveryTarget,
} from './deploymentActionOutcome';
import { DeploymentExecutionFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { createDeploymentActions } from './deploymentActions';
import { prepareDeploymentSourceCheckout } from './prepareDeploymentSourceCheckout';
import { DeploymentEnvironmentAgentActions } from './DeploymentEnvironmentAgentActions';
import { DeploymentEnvironmentSettingsPanel, type DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { showDeploymentFleetSheet } from './DeploymentFleetSheet';
import { StoredDefinitionOverview, useStoredDefinitionDocument } from './StoredDefinitionEditor';
import { DeploymentVersionComparison } from './DeploymentVersionComparison';
import { DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1, DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentDomainsPanel, type DeploymentDomainEditing } from './DeploymentDomainsPanel';
import { privateServiceExportReachLabel } from './DeploymentPrivateServiceExports';
import { projectDeploymentConnections, type DeploymentConnection } from './deploymentConnections';
import { DeploymentPermissionsPanel } from './DeploymentPermissionsPanel';
import { DeploymentServingReceipt } from './DeploymentServingReceipt';
import { DeploymentStepStrip } from './DeploymentStepStrip';
import { DeploymentActivityTimeline } from './DeploymentActivityTimeline';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { DeploymentTabState } from './DeploymentTabState';
import { DeploymentVariablesPanel } from './DeploymentVariablesPanel';
import { DeploymentDataCard } from './DeploymentDataCard';
import { showDeploymentAddSheet, showDeploymentTemplateUpdateSheet,
  showDeploymentAppSourcesSheet } from './DeploymentDatabasePage';
import { describeRegistrySourceFailure } from '@/registries/describeRegistrySourceStatus';
import { showDeploymentDispositionSheet } from './DeploymentDispositionSheet';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { showDeploymentLinkMachineSheet } from './DeploymentLinkMachineSheet';
import { showDeploymentPlatformTargetSheet, useDeploymentPlatformTargets, type DeploymentPlatformLinkActions } from './DeploymentPlatformTargetSheet';
import { DeploymentSourceMethodChoice } from './DeploymentSourceMethodChoice';
import { showDeploymentRestoreSheet, type DeploymentRestoreSheetInput } from './DeploymentRestoreSheet';
import { deploymentDataTargetOperands, isDeploymentEnvironmentSettingsSectionV1 } from '@happier-dev/deployments';
import { deploymentRestoreOperands, retainedBackupFromSummary } from './deploymentRestore';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { useDeploymentEnvironmentDeletion } from './useDeploymentEnvironmentDeletion';
import {
  useEnvironmentSecretBindingsDraft,
  type EnvironmentBindingsCommit,
} from './useEnvironmentSecretBindingsDraft';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDeploymentActorPresentations } from './useDeploymentActorPresentations';
import {
  useDeploymentEnvironment,
  useDeploymentHistory,
  useDeploymentReceipt,
  useEnvironmentBackupSummary,
  useDeploymentEnvironmentDomains,
} from './useDeploymentReads';
import { useEnvironmentNavigation, selectEnvironmentNavigationItem } from './environmentNavigation';
import { EnvironmentPageNavigation } from './EnvironmentNavigationViews';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { machineServiceColumnFields, machineServiceStateField } from '@/components/machines/services/machineServiceColumns';
import { machineServiceIcon, machineServiceStateLabel } from '@/components/machines/services/machineServicesPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { readDeploymentRefusalRecoveryV1, type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { showServiceCommandSheet } from '@/components/machines/services/command/ServiceCommandSheet';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import { DeploymentAdminLogin } from './DeploymentAdminLogin';
import type { EnvironmentCompanionId } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { EnvironmentLogsCompanion } from './EnvironmentLogsCompanion';
import type { DeploymentReadLogs } from './useDeploymentStepLog';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { randomUUID } from '@/platform/randomUUID';
import { DeploymentPullRequestDeploy } from './DeploymentPullRequestDeploy';
import { DeploymentPendingRequest } from './DeploymentPendingRequest';
import { DeploymentLiveAddressActions } from './deploymentLiveAddress';
import { formatDeploymentLiveAddress, resolveDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { DomainStateLine } from './DeploymentDomainRow';
import { readPlatformResourceName } from './platformTargetLink';
import { usePinnedEnvironmentIds } from '@/sync/domains/workspaces/projectAccountRows';
import { pinProjectService } from '@/sync/ops/actions/projectWorkspaceActions';

type EnvironmentTab = DeploymentEnvironmentTabV1;
const noEnvironmentName = () => null;
const readMachineOnline = (machine: Machine | null) =>
  machine ? isMachineOnline(machine) : null;
const RECENT_COUNT = 5;
const OVERVIEW: DeploymentEnvironmentDestinationV1 = Object.freeze({
  tab: 'overview',
  section: null,
});

/**
 * One Environment (lab d1 `det`): its identity and where it runs, then Overview — what serves now and its
 * recent receipts — and History. Every fact comes from the selected detail, its history page and the one
 * active receipt; nothing here starts its own observation.
 */
export const DeploymentEnvironmentDetail = React.memo(
  function DeploymentEnvironmentDetail(
    props: Readonly<{
      controller: DeploymentReadControllerV1;
      environmentId: string;
      demand: DeploymentReadDemandV1;
      accountId: string;
      serverId: string;
      phone: boolean;
      onOpenReceipt: (deploymentId: string) => void;
      /** Pushes one database's page in place (P9). */
      onOpenDatabase?: (database: string) => void;
      /** The Action owner's Deploy; absent while the Source's Account is not current. */
      deploy: ReturnType<typeof createDeploymentActions>['deploy'] | null;
      cancel?: ReturnType<typeof createDeploymentActions>['cancel'] | null;
      /** The page's one approval continuation: a held review opens the existing approval page. */
      review: DeploymentReviewHandle;
      /** Names a sibling Environment a variable reference points at, from the page's Environment list. */
      environmentTitle?: (environmentId: string) => string | null;
      /** This Project's Environments by id and name (the page's held list): where a variable reference may point. */
      referenceEnvironments?: React.ComponentProps<typeof DeploymentVariablesPanel>['referenceEnvironments'];
      /** The captured Home/Account the Variables draft writes under; absent while it is not current. */
      lifetime?: ServerAccountScopeLifetime | null;
      workspaceRef?: WorkspaceRefV1 | null;
      /** Outside a Project page, the Project the hosting route carries: named in the meta line and opened from it. */
      project?: Readonly<{ name: string; onOpen: () => void }> | null;
      /** The Environments list on this page already offers Prepare with an agent, so the Overview doesn't repeat it. */
      preparationInList?: boolean;
      /** The Action owner's `deployments.bindings.set`; absent where the page cannot write. */
      setBindings?: EnvironmentBindingsCommit | null;
      /** The open tab and Settings section, from the page's URL; a standalone render keeps its own. */
      destination?: DeploymentEnvironmentDestinationV1;
      onNavigate?: (destination: DeploymentEnvironmentDestinationV1) => void;
      /** The Action owner's target-membership Actions (Delete environment, Link and Unlink target); absent where the page cannot write. */
      disposition?: Pick<ReturnType<typeof createDeploymentActions>, 'deleteEnvironment' | 'unlink' | 'teardown' | 'link'> | null;
      /** The Environment was deleted: the page leaves it. */
      onDeleted?: () => void;
      /** Opens where a refused press's typed recovery leads (the Source, Variables, Machines…), as the receipt does. */
      onOpenRecoveryDestination?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
      /** The Action owner's masked stage-log reader for the Logs companion's Build view; absent where it cannot read. */
      readLogs?: DeploymentReadLogs | null;
      /** The Action owner's `deployments.restart` for a service row's ⋯; absent where the page cannot write. */
      restart?: ReturnType<typeof createDeploymentActions>['restart'] | null;
      /** The Action owner's backup restore; absent where the page cannot write. */
      restore?: ReturnType<typeof createDeploymentActions>['restore'] | null;
      /** The Action owner's Domain add, remove and Check again; absent where the page cannot write. */
      domainActions?: DeploymentDomainEditing['actions'] | null;
      /** The Action owner's controller and manager-setting edits; absent where the page cannot write. */
      environmentActions?: DeploymentEnvironmentEditing['actions'] | null;
      /** Duplicate opens the existing creation draft with this loaded source. */
      onDuplicate?: (source: DeploymentEnvironmentDetailV1) => void;
      /** The Action owner's platform inspect and Link; absent where the page cannot write. */
      platformLink?: DeploymentPlatformLinkActions | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // The person's pinned services on this Home, for the page menu's Pin (only this Home's pins wake it).
    const pinned = usePinnedEnvironmentIds(props.serverId);
    const {
      running: deploying, outcome, reviewPending, press, banner,
    } = useDeploymentPress(props.review, props.onOpenReceipt);
    const environment = useDeploymentEnvironment(
      props.controller,
      props.environmentId,
      props.demand,
    );
    const history = useDeploymentHistory(
      props.controller,
      props.environmentId,
      props.demand,
    );
    // One stable handler for every receipt row; each row binds its own id, so a parent render redraws none of them.
    const openReceipt = useEventCallback(props.onOpenReceipt);
    const openAdminAddress = useEventCallback((url: string) => {
      void requestOpenExternalUrl(url, { serverId: props.serverId, expectedAccountId: props.accountId });
    });
    const detail = environment.snapshot.value;
    const definitionDocument = useStoredDefinitionDocument(props.environmentId, detail?.content.definition);
    const projectSource = useProjectSource(props.lifetime ?? null, detail?.environment.projectSourceId ?? null);
    // "Point at another service" offers this Environment's declared exports (L-C variables/refpick).
    const serviceExports = detail?.content.ownServer?.serviceExports;
    const detailEnvironmentId = detail?.environment.id ?? null;
    const referenceTargets = React.useMemo(() => detailEnvironmentId && serviceExports
      ? serviceExports.map((entry) => ({ environmentId: detailEnvironmentId, export: entry.key, service: entry.service,
          network: privateServiceExportReachLabel(entry) }))
      : undefined, [detailEnvironmentId, serviceExports]);
    // The address under the title (lab d1): the first Domain that is not on its way out.
    const domains = useDeploymentEnvironmentDomains(props.controller, props.environmentId, props.demand);
    const domainHost = domains.result.items.find((item) => item.domain.state !== 'removing')?.content.hostname ?? null;
    const runtime = detail?.runtimeTargetLink ?? null;
    const activeId = runtime?.activeDeploymentId ?? null;
    const active = useDeploymentReceipt(
      props.controller,
      props.environmentId,
      activeId,
      props.demand,
    );
    // The serving deploy's pre-migration backup, from the same receipt lease: the restore entry on Settings → Backups.
    const backupSummary = useEnvironmentBackupSummary(
      props.controller,
      props.environmentId,
      activeId,
      props.demand,
    );
    const machineIds = React.useMemo(
      () => runtime?.machines ?? [],
      [runtime?.machines],
    );
    // Build and controller Machines are named too, so Settings still names them while nothing is linked.
    const controllerMachineId = detail?.environment.controllerMachineId ?? null;
    const buildMachineId = detail?.environment.buildMachineId ?? null;
    const namedMachineIds = React.useMemo(
      () => [...new Set([...machineIds, ...(controllerMachineId ? [controllerMachineId] : []), ...(buildMachineId ? [buildMachineId] : [])])],
      [buildMachineId, controllerMachineId, machineIds],
    );
    const machineNames = useMachineDisplayNamesById(namedMachineIds, { serverId: props.serverId });
    // A platform Environment's header names its platform (lab d4), as the rail row does.
    const platforms = useDeploymentPlatformTargets(runtime?.source.kind === 'plugin' && props.demand.mounted && props.demand.visible
      ? props.lifetime ?? null : null);
    const platformRef = runtime?.source.kind === 'plugin' ? runtime.source.contribution : null;
    const platform = platforms.state.status === 'ready' && platformRef
      ? platforms.state.targets.find(target => target.pluginId === platformRef.pluginId
        && target.targetId === platformRef.localId) : undefined;
    const platformRuntime = React.useMemo<Extract<PluginUiHostReadReferenceV1, { hostRead: 'deployments.logs' }> | undefined>(() => {
      const receipt = active.snapshot.value;
      const providerDeploymentId = receipt?.content.platform?.observation.providerDeploymentId;
      const reference = receipt?.facts.logs[0]?.reference;
      if (!platform?.runtimeLogs || !providerDeploymentId || !reference) return undefined;
      return { hostRead: 'deployments.logs', sourceRevision: providerDeploymentId,
        input: { ...reference, kind: 'runtime', serverId: props.serverId } };
    }, [active.snapshot.value, platform?.runtimeLogs, props.serverId]);
    const [selectedMethod, setSourceMethod] = React.useState<Readonly<{ targetLinkId: string; value: DeploymentSourceMethodV1 }> | null>(null);
    // This choice belongs to the next invocation, never to Environment configuration.
    const [failurePolicyDraft, setFailurePolicyDraft] = React.useState<Readonly<{
      serverId: string; accountId: string; environmentId: string; value: DeploymentOnFailureV1;
    }> | null>(null);
    const onFailure = runtime?.source.kind === 'host' && runtime.members.length > 1
      ? failurePolicyDraft?.serverId === props.serverId && failurePolicyDraft.accountId === props.accountId
        && failurePolicyDraft.environmentId === props.environmentId
        ? failurePolicyDraft.value : DEFAULT_DEPLOYMENT_ON_FAILURE_V1
      : undefined;
    const sourceMethod = platform?.sourceMethods.includes('upload')
      ? resolveDeploymentSourceMethodV1({
        explicit: selectedMethod !== null && selectedMethod.targetLinkId === runtime?.id && platform.sourceMethods.includes(selectedMethod.value)
          ? selectedMethod.value : undefined,
        recorded: detail?.targetLinks.find(row => row.targetLink.id === runtime?.id)?.content?.sourceMethod,
      })
      : undefined;
    // Its Triggers run where it is deployed (OPS-AUTOMATIONS-1102 D2), or on its controller before anything is.
    const triggerMachineId = machineIds[0] ?? controllerMachineId;
    const triggerSubject = React.useMemo(() => triggerMachineId
      ? { kind: 'environment' as const, machineId: triggerMachineId, environmentId: props.environmentId } : null,
    [triggerMachineId, props.environmentId]);
    // Its configured backup stream is read with it, so a backup's triggers show in its Automations (Plan 05).
    const backupConfigured = !!detail?.content.backup && 'configRevision' in detail.content.backup;
    const backupContext = React.useMemo(() => backupConfigured
      ? [{ kind: 'backup' as const, serverId: props.serverId, environmentId: props.environmentId }] : undefined,
    [backupConfigured, props.serverId, props.environmentId]);
    const [ownDestination, setOwnDestination] =
      React.useState<DeploymentEnvironmentDestinationV1>(OVERVIEW);
    const { tab, section: settingsSection } =
      props.destination ?? ownDestination;
    const onNavigate = props.onNavigate ?? setOwnDestination;
    // Automations sit under the Settings panel; a link to them (Project defaults) scrolls there (D16, F8).
    const automationsReveal = useSettingReveal(tab === ENVIRONMENT_AUTOMATIONS_DESTINATION.tab
      && settingsSection === ENVIRONMENT_AUTOMATIONS_DESTINATION.section ? settingsSection : null, REVEAL_DELAY_MS);
    const navigationScope = React.useMemo(() => ({ serverId: props.serverId, accountId: props.accountId }), [props.serverId, props.accountId]);
    const buildDeploymentId = history.result.items[0]?.id ?? activeId;
    const logsOffered = detail !== null && (buildDeploymentId !== null || (machineIds.length === 1 && runtime?.source.kind === 'host'));
    const navigation = useEnvironmentNavigation({ scope: navigationScope, environmentId: props.environmentId,
      companions: logsOffered ? LOGS_COMPANION : NO_COMPANION,
      destination: props.destination ?? ownDestination, phone: props.phone,
      presented: props.demand.mounted && props.demand.visible && props.demand.focused, navigate: onNavigate });
    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    // The Logs companion keeps the service a row opened it for; its own field changes it after that.
    const [logsService, setLogsService] = React.useState<string | null>(null);
    const openLogs = useEventCallback((service: string) => {
      setLogsService(service);
      navigation.companion.open('logs');
    });
    const selectPage = (id: string) => selectEnvironmentNavigationItem(executeNavigation, navigation.model, id);
    const openTab = (
      next: EnvironmentTab,
      section: DeploymentEnvironmentSettingsSectionV1 | null = null,
    ) => {
        selectEnvironmentNavigationItem(executeNavigation, navigation.model, next, section);
    };
    // The draft lives with the page, so a tab switch keeps unsaved Variables edits.
    const bindings = useEnvironmentSecretBindingsDraft({
      environmentId: props.environmentId,
      lifetime: props.lifetime ?? null,
      snapshot: environment.snapshot,
      setBindings: props.setBindings ?? null,
    });
    const previewActions = React.useMemo(() => props.lifetime && detail
      ? createDeploymentActions(props.lifetime, detail.environment.projectSourceId) : null,
    [props.lifetime, detail?.environment.projectSourceId]);
    const previewBindings = useEnvironmentSecretBindingsDraft({ environmentId: props.environmentId,
      lifetime: props.lifetime ?? null, snapshot: environment.snapshot, bindingTarget: 'previewTemplate',
      readOnly: !props.environmentActions,
      setBindings: props.environmentActions && previewActions ? async (input, operation, base) => {
        const template = base.content.previewTemplate;
        if (!template) throw new Error('deployment_unavailable');
        const result = await previewActions.setPreviewBindings(base.environment, template, input, operation);
        if (result.ok) void environment.refresh();
        return result;
      } : null });
    const disposition = useDeploymentEnvironmentDeletion({
      environmentId: props.environmentId,
      lifetime: props.lifetime ?? null,
      snapshot: environment.snapshot,
      actions: props.disposition ?? null,
      controller: props.controller,
      demand: props.demand,
    });
    // Only the verdict is subscribed, so presence heartbeats do not redraw the page.
    const machineOnline = useServerScopedMachine(
      props.serverId,
      machineIds.length === 1 ? machineIds[0] : null,
      readMachineOnline,
    );

    if (!detail) {
      // Shaped like the page while the Environment read settles (R5); a failed read is one card with Retry.
      if (environment.snapshot.status !== 'unavailable') {
        return <PageLoadingRows testID="project-deployments.environment.loading" header />;
      }
      const diagnosticCode = environment.snapshot.failure?.code ?? null;
      const homeUnreachable = deploymentReadIssue(diagnosticCode) === 'homeUnreachable';
      return (
        <ItemList testID="project-deployments.environment.state">
          <EnvironmentPageNavigation navigation={navigation} phone={props.phone} onSelect={selectPage} />
          {environment.snapshot.status === 'unavailable' ? (
            <SurfaceStateCard
              kind="error"
              title={t(homeUnreachable ? 'projects.deployments.unavailableTitle' : 'projects.deployments.environmentErrorTitle')}
              diagnosticCode={diagnosticCode}
              action={{
                label: t('common.retry'),
                onPress: () => {
                  void environment.refresh();
                },
              }}
            />
          ) : (
            <SurfaceStateCard
              kind="loading"
              title={t('projects.deployments.loading')}
            />
          )}
        </ItemList>
      );
    }

    // A removed Environment keeps its address and record; the page says it is gone instead of drawing a live one.
    if (detail.environment.deletedAtMs !== undefined) {
      return (
        <ItemList testID="project-deployments.environment.removed">
          <PageHeader
            testID="project-deployments.environment.header"
            title={detail.content.name}
            alwaysShowTitle
            leading={<PageHeaderMarkIcon name="cloud-slash" />}
            description={t('projects.deployments.removedOn', { when: formatAsOfTime(detail.environment.deletedAtMs) })}
          />
          <ItemGroup header="none">
            <Item
              testID="project-deployments.environment.removed.notice"
              title={t('projects.deployments.removedTitle')}
              subtitle={t('projects.deployments.removedBody')}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
          </ItemGroup>
          {history.result.items.length > 0 ? (
            <ItemGroup testID="project-deployments.environment.recent" title={t('projects.deployments.recent')}>
              {history.result.items.slice(0, RECENT_COUNT).map((receipt) => (
                <DeploymentReceiptRow key={receipt.id} receipt={receipt} live={false}
                  actor={deploymentActorIsViewer(receipt.actor, props.accountId) ? t('projects.deployments.byYou') : null}
                  phone={props.phone} onOpen={openReceipt} />
              ))}
            </ItemGroup>
          ) : null}
        </ItemList>
      );
    }

    const machineName = (machineId: string) =>
      machineNames[machineId] ?? t('projects.deployments.aMachine');
    const activeReceipt = active.snapshot.value;
    const services = activeReceipt ? deploymentServices(activeReceipt.content) : NO_SERVICES;
    // What serves is live at its address; a first deploy that serves ends there (P60 §1 step 5): its address
    // leads the page and Open is the one primary until the Environment has deployed again.
    // The active receipt serves by definition; the live-address owner decides which states and Domains count.
    const liveAddress = activeReceipt ? resolveDeploymentLiveAddress(activeReceipt, domains.result.items, true) : null;
    const liveUrl = liveAddress?.url ?? null;
    const historyPage = history.snapshot.status === 'ready' ? history.snapshot.value : null;
    // An address whose Domain needs a look never leads as plainly live; its recovery does.
    const firstServing = liveUrl !== null && !liveAddress?.attention && historyPage !== null && !historyPage.hasNextPage
      && historyPage.coverage !== 'partial'
      && historyPage.items.every(receipt => receipt.operation === 'teardown' || receipt.id === activeId);
    // Declared edges only (#23): the page's one Domains read and the stored template, never a per-resource read.
    const connections = projectDeploymentConnections(detail, domains.result).items;
    const primaryService = detail.content.definition.kind === 'repository'
      ? detail.content.definition.compose?.primaryService : detail.content.definition.primaryService;
    const adminDomain = primaryService ? domains.result.items.find(item =>
      isDeploymentDomainAttachedV1(item.domain, detail.environment)
      && (item.domain.state === 'active' || item.domain.state === 'warning')
      && item.content.target.service === primaryService) : undefined;
    const adminServingUrl = adminDomain ? readDeploymentDomainServingUrlV1(adminDomain.content) : null;
    // Where a name is only a fact or a clause, an unknown Machine drops out instead of reading "a machine".
    const knownMachine = (machineId: string | undefined) => (machineId ? machineNames[machineId] ?? null : null);
    const definition = deploymentDefinitionLabel(detail.content);
    const ciHome = getServerProfileById(props.serverId);
    const ciInput = detail.content.definition.kind === 'repository' && detail.environment.capabilities.deploy && props.lifetime && ciHome
      ? { environmentId: detail.environment.id, name: detail.content.name, protection: detail.environment.protection,
          serverIdentityId: detail.environment.serverId, serverApiUrl: ciHome.canonicalServerUrl ?? ciHome.serverUrl,
          scope: props.lifetime.scope, lifetime: props.lifetime } satisfies DeploymentCiInput : null;
    const platformName = platform?.title ?? null;
    // Where it runs, what defines it, then where people reach it (lab d1 header): vps-2 · Compose · compose.yaml · address.
    const composeHosted = runtime ? runtime.source.kind === 'host' : definition !== null;
    const meta: PageHeaderMetaFact[] = [
      ...(platformName ? [{ key: 'platform', text: platformName }] : []),
      ...machineIds.flatMap((machineId) => {
        const name = knownMachine(machineId);
        return name ? [{ key: `machine:${machineId}`, text: name, icon: 'hard-drives' as const }] : [];
      }),
      // The Project the hosting page carries (lab `envOv` meta): named in ink, opening it.
      ...(props.project ? [{ key: 'project', text: props.project.name, testID: 'project-deployments.environment.project',
        accessibilityLabel: t('projects.deployments.overviewStatus.openProject', { project: props.project.name }),
        onPress: props.project.onOpen }] : []),
      ...(composeHosted ? [{ key: 'compose', text: t('projects.deployments.compose') }] : []),
      ...(composeHosted && definition ? [{ key: 'definition', text: definition, mono: true }] : []),
      // Overview's live row says the address once it serves; elsewhere the header still names where it is reached.
      ...(domainHost && !(liveUrl && tab === 'overview') ? [{ key: 'domain', text: domainHost, icon: 'globe' as const }] : []),
    ];
    const environmentEditing: DeploymentEnvironmentEditing | null = props.environmentActions ? {
      actions: props.environmentActions,
      serverId: props.serverId,
      review: props.review,
      onChanged: () => { void environment.refresh(); },
    } : null;
    const availability = deploymentDeployAvailability(detail);
    const ready = availability.kind === 'ready' && props.deploy !== null;
    const offline = ready && machineOnline === false;
    const environmentAgentActions = (
      <DeploymentEnvironmentAgentActions serverId={props.serverId} environmentId={detail.environment.id}
        controllerMachineId={detail.environment.controllerMachineId}
        preparation={!props.preparationInList && props.lifetime && detail.content.definition.kind === 'repository'
          ? { lifetime: props.lifetime, projectSourceId: detail.environment.projectSourceId } : undefined}
        compact={props.phone} emphasis={ready ? 'secondary' : 'primary'} placement={ready ? 'section' : 'facts'} />
    );
    const { review, environmentId } = props;
    const deployAction = props.deploy;
    const deploy: typeof props.deploy = deployAction ? async (...args) => {
      const [input] = args;
      if (props.lifetime && !('sourceIntent' in input && input.sourceIntent?.kind === 'stored')) await prepareDeploymentSourceCheckout(props.lifetime, detail,
        projectSource.resolveSource, 'sourceMethod' in input ? input.sourceMethod : sourceMethod);
      return deployAction(...args);
    } : null;
    const pressDeploy = async () => {
      if (!deploy || availability.kind !== 'ready') return;
      await press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId, ...(onFailure ? { onFailure } : {}), ...(sourceMethod ? { sourceMethod } : {}) }));
    };
    const liveSha =
      active.snapshot.value?.content.sourceIntent?.kind === 'repository'
        ? active.snapshot.value.content.sourceIntent.sha
        : null;
    const pressRedeploy = async () => {
      if (!deploy || availability.kind !== 'ready' || !liveSha) return;
      await press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId, ...(onFailure ? { onFailure } : {}), sha: liveSha, ...(sourceMethod ? { sourceMethod } : {}) }));
    };
    const deployBlocked =
      deploying ||
      offline ||
      reviewPending ||
      (outcome?.kind === 'refused' && outcome.reason === 'unsupported');
    const deployDisplay = firstServing ? 'secondary' as const : undefined;
    const deployTint = firstServing ? theme.colors.text.primary : theme.colors.button.primary.tint;
    const primaryDeploy = ready ? (
      <RoundButton
        testID="project-deployments.environment.deploy"
        display={deployDisplay}
        size="normal"
        // Beside its chevron the two read as one split control (lab d1 header).
        joinedEdge={liveSha ? 'end' : undefined}
        // A phone's pinned primary spans the bar (lab d1p).
        style={props.phone ? styles.phoneDeploy : undefined}
        title={t('projects.deployments.deploy')}
        leading={
          <Icon
            name="rocket-launch"
            size={14}
            color={deployTint}
          />
        }
        loading={deploying}
        disabled={
          deploying ||
          offline ||
          reviewPending ||
          (outcome?.kind === 'refused' && outcome.reason === 'unsupported')
        }
        onPress={() => {
          void pressDeploy();
        }}
      />
    ) : undefined;
    // Deploy's chevron holds the other ways to deploy that can succeed now (lab d1 header).
    const deployButton =
      primaryDeploy && liveSha ? (
        <View style={[styles.split, props.phone && styles.phoneSplit]}>
          {primaryDeploy}
          <DeployMoreMenu
            display={deployDisplay}
            tint={deployTint}
            disabled={deployBlocked}
            phone={props.phone}
            onRedeploy={() => {
              void pressRedeploy();
            }}
          />
        </View>
      ) : (
        primaryDeploy
      );
    // Earlier settled teardowns are named to the removal, which admits them as proof nothing of it still runs.
    const settledTeardowns = (history.snapshot.value?.items ?? [])
      .filter((receipt) => receipt.operation === 'teardown' && receipt.state === 'succeeded')
      .map((receipt) => receipt.id);
    const knownHistory = historyPage;
    const hasNoDeploymentHistory = (targetLinkId: string | null) => knownHistory !== null && !knownHistory.hasNextPage
      && knownHistory.coverage !== 'partial' && !knownHistory.items.some(receipt => receipt.operation !== 'teardown'
        && (!targetLinkId || receipt.targetLinkId === targetLinkId));
    const openDisposition = (targetLinkId: string | null) => {
      const links = disposition.review.retainedTargets;
      const subject = targetLinkId ? links.find((link) => link.id === targetLinkId) ?? null : null;
      const running = subject ? subject.activeDeploymentId !== null : links.some((link) => link.activeDeploymentId !== null);
      const machines = subject ? subject.machines : machineIds;
      const neverDeployed = !running && hasNoDeploymentHistory(targetLinkId);
      const { onDeleted } = props;
      const dispositionRow = detail.targetLinks.find(row => row.targetLink.id === (targetLinkId ?? detail.environment.runtimeTargetLinkId));
      const dispositionLink = dispositionRow?.targetLink;
      const dispositionPlatformRef = dispositionLink?.source.kind === 'plugin' ? dispositionLink.source.contribution : null;
      const dispositionPlatform = platforms.state.status === 'ready' && dispositionPlatformRef
        ? platforms.state.targets.find(target => target.pluginId === dispositionPlatformRef.pluginId
          && target.targetId === dispositionPlatformRef.localId) : null;
      const provider = dispositionPlatformRef ? dispositionPlatform?.title ?? dispositionLink?.targetKind ?? null : null;
      // The removal owner decides which choices exist and where the review starts (created: Delete; linked: Unlink).
      const removal = selectDeploymentTargetRemovalChoicesV1(dispositionLink?.source,
        platforms.state.status === 'ready' ? platforms.state.targets : [], dispositionRow?.content?.providerResourceOrigin);
      showDeploymentDispositionSheet({
        subject: targetLinkId ? { kind: 'target', targetLinkId } : { kind: 'environment' },
        // Stop and remove tears down first; then the target is unlinked or the Environment deleted.
        agentApproval: { environment: detail.environment, actionIds: [DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
          targetLinkId ? DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1 : DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1] },
        name: detail.content.name,
        machine: machines.length > 0 ? machines.map(machineName).join(', ') : null,
        provider,
        running,
        services: services.map((service) => service.name),
        hasRetainedAssociations: targetLinkId ? subject !== null : links.length > 0,
        canRemove: removal.choices.includes('delete'),
        ...(dispositionPlatformRef && provider ? { providerResource: {
          name: readPlatformResourceName(dispositionRow?.content) ?? detail.content.name,
          consequence: dispositionPlatform?.teardownConsequence ?? null, defaultChoice: removal.defaultChoice } } : {}),
        ...(dispositionLink?.source.kind === 'host'
          ? { reviewVolumes: async (signal: AbortSignal) => {
              if (neverDeployed) return [];
              const result = await props.disposition!.teardown({ environmentId: detail.environment.id,
                ...(targetLinkId ? { targetLinkId } : {}), reason: 'manual', mode: 'preview' }, { signal });
              if (!result.ok) throw new HappyError(result.error, true, { code: result.error,
                details: 'details' in result ? result.details : result,
                ...('failureCause' in result ? { failureCause: result.failureCause } : {}) });
              if (!('kind' in result) || result.kind !== 'preview') throw new HappyError('invalid_action_output', false,
                { code: 'invalid_action_output' });
              return result.volumes;
            } } : {}),
        ...(!targetLinkId || running ? { domains: { controller: props.controller, environmentId: detail.environment.id } } : {}),
        // This review is the person's confirmation of the exact Actions, so the front door does not ask again.
        // Deployment history requires teardown; Home admits removal of a resource-free configured record.
        // Provider deletion is one teardown the provider carries out; deleting only the target keeps the Environment.
        run: (choice, volumes) => choice === 'remove' && dispositionPlatformRef
          ? disposition.stopAndRemove(targetLinkId, undefined, undefined,
            { providerRemoval: 'delete', ...(targetLinkId ? { removeEnvironment: false } : {}) })
          : choice === 'remove' && (running || (!neverDeployed && !targetLinkId && detail.environment.runtimeTargetLinkId != null))
          ? disposition.stopAndRemove(targetLinkId, undefined, volumes)
          : targetLinkId
            ? disposition.unlink(targetLinkId, choice === 'detach' ? { kind: 'detachKeepRunning' } : { kind: 'afterTeardown' },
              { confirmed: true })
            : disposition.deleteEnvironment(choice === 'detach'
              ? { kind: 'detachKeepRunning' }
              : { kind: 'afterTeardown', deploymentIds: settledTeardowns },
            { confirmed: true }),
        recovery: { controller: props.controller, environmentId: props.environmentId,
          cancel: props.cancel ?? null, review, onOpenReceipt: props.onOpenReceipt,
          onHistory: () => onNavigate({ tab: 'history', section: null }) },
        onApproval: review.request,
        onDone: (outcome) => {
          if (outcome.kind === 'deleted') onDeleted?.();
        },
      });
    };
    // Link a machine (lab `servers/add`): the sheet is where the link is made, wherever the person asks for it.
    const openLink = disposition.canLink ? () => {
      showDeploymentLinkMachineSheet({
        name: detail.content.name,
        serverId: props.serverId,
        suggestedMachineId: detail.environment.controllerMachineId,
        run: (machine) => disposition.link(machine, { confirmed: true }),
        onApproval: review.request,
      });
    } : null;
    // Add a platform target: the same manage-targets capability as a machine link, through the plugin's own target.
    const platformLink = props.platformLink ?? null;
    const lifetime = props.lifetime ?? null;
    const previewAvailability = deploymentPreviewAvailability(detail);
    const openPlatform = disposition.canLink && platformLink && lifetime ? (initialTargetKey?: string) => {
      showDeploymentPlatformTargetSheet({
        initialTargetKey: initialTargetKey ?? null,
        name: detail.content.name,
        environment: { id: detail.environment.id, revision: detail.environment.revision,
          projectSourceId: detail.environment.projectSourceId, controllerMachineId: detail.environment.controllerMachineId,
          definition: detail.content.definition },
        ownerAccountId: props.accountId,
        lifetime,
        actions: platformLink,
        onApproval: review.request,
        ...(props.onOpenRecoveryDestination ? { onOpenRecoveryDestination: props.onOpenRecoveryDestination } : {}),
      });
    } : null;
    // Restore a backup: the pre-migration dump the serving deploy kept, read from the active receipt the page
    // already holds. The restore Action decides admission at each press.
    const servingReceipt = active.snapshot.value;
    const fleetLink = runtime?.targetKind === 'ownServer' && runtime.source.kind === 'host'
      ? { ...runtime, source: runtime.source } : null;
    const openFleet = lifetime && detail.environment.capabilities.manageTargets && fleetLink
      ? () => showDeploymentFleetSheet({ detail, runtimeLink: fleetLink, receipt: servingReceipt, lifetime }) : null;

    const retainedBackup = backupSummary.result.value && servingReceipt
      ? retainedBackupFromSummary(backupSummary.result.value, deploymentSourceLabel(servingReceipt.content)) : null;
    const restoreAction = props.restore ?? null;
    const restoreOperands = retainedBackup ? deploymentRestoreOperands(detail, retainedBackup) : null;
    const restoreTarget = deploymentDataTargetOperands(detail);
    const backupSources = detail.content.backup && 'configRevision' in detail.content.backup ? detail.content.backup.sources : [];
    const uploadDestinations: NonNullable<DeploymentRestoreSheetInput['uploadTarget']>['destinations'] = backupSources.map(source =>
      source.kind === 'volume' ? { kind: 'volume', service: source.service, volume: source.volume }
        : { kind: 'database', service: source.service,
          ...(retainedBackup?.service === source.service ? { database: retainedBackup.database } : {}) });
    const uploadTarget: DeploymentRestoreSheetInput['uploadTarget'] = lifetime && restoreTarget && activeId && uploadDestinations.length
      ? { scope: lifetime.scope, operands: { ...restoreTarget, deploymentId: activeId }, destinations: uploadDestinations } : undefined;

    // P10: the Add sheet opens over the Environment, in place; it never leaves for Store. Settings › Backups reuses it.
    const openAddDatabase = lifetime ? () => {
      showDeploymentAddSheet({ detail, lifetime, review: props.review, machineName, catalogFilters: DEPLOYMENT_DATABASE_CATALOG_FILTER,
        onNavigate: (destination) => openTab(destination.tab),
        ...(props.onOpenRecoveryDestination ? { onOpenRecovery: props.onOpenRecoveryDestination } : {}) });
    } : null;
    const templateRef = detail.content.template?.templateRef;
    const openTemplateUpdate = lifetime && templateRef && detail.environment.capabilities.manage
      && detail.environment.capabilities.manageBindings ? () => showDeploymentTemplateUpdateSheet({
        detail, lifetime, review: props.review, machineName, catalogFilters: {}, template: templateRef,
        onNavigate: destination => openTab(destination.tab),
        ...(props.onOpenRecoveryDestination ? { onOpenRecovery: props.onOpenRecoveryDestination } : {}),
      }) : null;
    const openRestore = restoreAction && (retainedBackup && restoreOperands || uploadTarget) ? () => {
      showDeploymentRestoreSheet({
        serverId: detail.environment.serverId,
        name: detail.content.name,
        machine: machineName(restoreOperands?.machineId ?? uploadTarget!.operands.machineId),
        ...(retainedBackup && restoreOperands ? { backup: retainedBackup, operands: restoreOperands } : {}),
        ...(uploadTarget ? { uploadTarget } : {}),
        restore: (input, operation) => restoreAction(input, operation),
        onApproval: review.request,
      });
    } : null;
    const moveEligibility = readDeploymentMoveEligibility(detail, runtime, activeReceipt, lifetime);
    const environmentMenu = (
      <EnvironmentMenu
        onDuplicate={props.onDuplicate ? () => props.onDuplicate?.(detail) : undefined}
        move={moveEligibility.kind === 'ready' ? {
          kind: 'ready', open: () => showDeploymentMoveSheet({ detail, move: moveEligibility }),
        } : moveEligibility}
        onOpenHistory={activeId !== null && history.result.items.some((receipt) => receipt.id !== activeId && receipt.state === 'succeeded')
          ? () => selectPage('history') : undefined}
        onOpenSettings={() => selectPage('settings')}
        // The header opener for the Logs companion (ruling 11-08, option a): offered only while Logs is.
        logs={logsOffered ? { open: navigation.companion.activeId === 'logs', toggle: () => {
          if (navigation.companion.activeId === 'logs') navigation.companion.close();
          else navigation.companion.open('logs');
        } } : undefined}
        deleteTitle={disposition.canDelete ? t('projects.deployments.menuDelete', { name: detail.content.name }) : null}
        onDelete={() => openDisposition(null)}
        deployProduction={detail.environment.purpose === 'preview'
          ? { projectSourceId: detail.environment.projectSourceId, previewEnvironmentId: detail.environment.id } : undefined}
        pin={{ pinned: pinned.includes(detail.environment.id), toggle: () => {
          void pinProjectService({ serverId: props.serverId, environmentId: detail.environment.id, pinned: !pinned.includes(detail.environment.id) });
        } }}
      />
    );
    const machineLabel = machineName(machineIds[0] ?? '');
    const offlineMachine = offline ? knownMachine(machineIds[0]) : null;
    const receipts = history.result.items;
    const recentReceipts = receipts.filter((receipt) => receipt.id !== activeId).slice(0, RECENT_COUNT);
    const openServingReceipt = () => { if (activeReceipt) props.onOpenReceipt(activeReceipt.deployment.id); };
    const servingNotice = activeReceipt ? deploymentStateNotice(activeReceipt.deployment.state) : null;
    // Overview owns the whole precedence; other tabs keep only what blocks their own presses.
    const overview = tab === 'overview';
    const latest = overview ? history.result.items[0] ?? null : null;
    const attention = deploymentEnvironmentAttention({
      machineOffline: offlineMachine !== null,
      noTarget: availability.kind === 'noTarget',
      controller: overview ? detail.controller ?? null : null,
      refused: outcome?.kind === 'refused',
      reviewPending,
      latest,
      health: overview ? detail.healthAggregate ?? null : null,
      servingState: overview ? activeReceipt?.deployment.state ?? null : null,
      catalogUpdate: overview && Boolean(templateRef && (environment.catalogUpdate.upstream
        && environment.catalogUpdate.upstream.state !== 'current' || environment.catalogUpdate.error)),
    });
    const deployWhenFinished = ready && deploy && availability.kind === 'ready' ? () => {
      void press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId, ...(onFailure ? { onFailure } : {}), whenBusy: 'supersede', ...(sourceMethod ? { sourceMethod } : {}) }));
    } : null;
    const liveDomain = liveAddress?.attention ? liveAddress.domain : null;
    const domainActions = props.domainActions;
    const liveActions = (url: string) => (
      <DeploymentLiveAddressActions url={url} serverId={props.serverId} accountId={props.accountId}
        testIDPrefix="project-deployments.environment.live" openEmphasis={firstServing ? 'primary' : 'secondary'}
        checkAgain={liveDomain && domainActions ? { review: props.review, onSettled: () => { void environment.refresh(); },
          run: () => domainActions.verifyDomain({ environmentId, domainId: liveDomain.id,
            expectedRevision: detail.environment.revision, expectedDomainRevision: liveDomain.revision }) } : null} />
    );
    const attentionNotice = (() => {
      switch (attention?.kind) {
        case undefined:
          // A just-accepted Deploy says so once, when nothing above it needs saying.
          return outcome?.kind === 'started' ? (
            <DeployOutcomeBanner controller={banner}
              machine={runtime?.source.kind === 'plugin' ? null : machineLabel}
              machineId={runtime?.source.kind === 'plugin' || machineIds.length !== 1 ? null : machineIds[0]} />
          ) : null;
        case 'machineOffline':
          // The notice slot draws every condition as its one banner, on the sheets' edges a section gap under the tabs
          // (R2-D10: a freshness line inside a section took the rows' inset and sat 4 px under the tabs).
          return (
            <AttentionBanner
              testID="project-deployments.environment.offline"
              tone="neutral"
              title={t('projects.deployments.machineOffline', { machine: offlineMachine! })}
            />
          );
        case 'noTarget':
          return (
            <AttentionBanner
              testID="project-deployments.environment.unavailable.noTarget"
              tone="neutral"
              title={t('projects.deployments.deployUnavailableTitle')}
              description={definition
                ? t('projects.deployments.deployNoTarget')
                : t('projects.deployments.platformLink.deployNoPlatform')}
              // The rail's Machine is the controller; deploying needs a runtime link, which the Link a machine sheet makes.
              // A Machine runs a Compose file, so an Environment without one is offered only a platform.
              {...(openLink && definition
                ? { action: { label: t('projects.deployments.linkMachine'), onPress: openLink } }
                : {})}
              {...(openPlatform
                ? definition
                  ? { secondaryAction: { label: t('projects.deployments.platformLink.usePlatform'), onPress: () => openPlatform() } }
                  : { action: { label: t('projects.deployments.platformLink.usePlatform'), onPress: () => openPlatform() } }
                : {})}
            />
          );
        case 'controllerPaused':
          return (
            <AttentionBanner
              testID="project-deployments.environment.attention.controllerPaused"
              tone="neutral"
              title={t('projects.deployments.overviewStatus.controllerPausedTitle')}
              description={t('projects.deployments.overviewStatus.controllerPausedBody', {
                machine: machineName(detail.controller?.machineId ?? detail.environment.controllerMachineId),
              })}
            />
          );
        case 'actionRefused':
        case 'approvalWaiting':
          return outcome ? (
            <DeployOutcomeBanner controller={banner}
              machine={runtime?.source.kind === 'plugin' ? null : machineLabel}
              machineId={runtime?.source.kind === 'plugin' || machineIds.length !== 1 ? null : machineIds[0]} />
          ) : null;
        case 'latestFailed': {
          const failedId = attention.deploymentId;
          return (
            <AttentionBanner
              testID="project-deployments.environment.attention.latestFailed"
              tone="danger"
              title={t('projects.deployments.overviewStatus.latestFailedTitle')}
              description={latest ? deploymentHistoryLead(latest, latest.failure)?.text : undefined}
              action={{ label: t('projects.deployments.overviewStatus.openReceipt'), onPress: () => props.onOpenReceipt(failedId) }}
            />
          );
        }
        case 'deploying': {
          const runningId = attention.deploymentId;
          return (
            <AttentionBanner
              testID="project-deployments.environment.attention.deploying"
              tone="neutral"
              title={t('projects.deployments.overviewStatus.deployingTitle')}
              description={deployWhenFinished ? t('projects.deployments.overviewStatus.deployingBody') : undefined}
              action={{ label: t('projects.deployments.overviewStatus.openReceipt'), onPress: () => props.onOpenReceipt(runningId) }}
              {...(deployWhenFinished ? { secondaryAction: {
                label: t('projects.deployments.overviewStatus.deployWhenFinished'), onPress: deployWhenFinished,
              } } : {})}
            />
          );
        }
        case 'unhealthy': {
          const health = deploymentHealthFact(detail.healthAggregate, activeReceipt?.deployment.state);
          return (
            <AttentionBanner
              testID="project-deployments.environment.attention.unhealthy"
              tone={health.tone === 'danger' ? 'danger' : 'warning'}
              title={health.value}
              description={services.length > 0 ? t('projects.deployments.overviewStatus.unhealthyBody') : undefined}
            />
          );
        }
        case 'catalogUpdate': {
          const upstream = environment.catalogUpdate.upstream;
          const updateAvailable = upstream?.state === 'update_available';
          return (
            <AttentionBanner
              testID="project-deployments.environment.attention.catalogUpdate"
              tone="neutral"
              title={t(updateAvailable ? 'projects.deployments.overviewStatus.catalogUpdateTitle'
                : 'projects.deployments.overviewStatus.catalogSourceUnavailableTitle')}
              description={updateAvailable ? t('projects.deployments.overviewStatus.catalogUpdateBody')
                : upstream?.state === 'removed_from_source' ? t('projects.deployments.overviewStatus.catalogSourceRemovedBody')
                  : describeRegistrySourceFailure(upstream?.state === 'unchecked' ? upstream.reason : environment.catalogUpdate.status,
                    environment.catalogUpdate.sourceTitle)}
              {...(updateAvailable ? openTemplateUpdate ? { action: {
                label: t('projects.deployments.overviewStatus.catalogUpdateReview'), onPress: openTemplateUpdate,
              } } : {} : templateRef ? { action: { label: t('capabilities.registries.select.manage'),
                onPress: () => showDeploymentAppSourcesSheet(templateRef.sourceId) },
                secondaryAction: { label: t('common.retry'), onPress: () => { void environment.catalogUpdate.refresh(); } } } : {})}
            />
          );
        }
        case 'runningUnverified':
          // The receipt's own notice, where the person looks first (lab d1 `unverified`).
          return servingNotice ? (
            <AttentionBanner
              testID="project-deployments.environment.serving.notice.running_unverified"
              tone={servingNotice.tone}
              title={deploymentStateLabel('running_unverified')}
              description={servingNotice.text}
            />
          ) : null;
      }
    })();

    return (
      <View style={styles.page}>
        <ItemList testID="project-deployments.environment">
          <PageHeader
            testID="project-deployments.environment.header"
            title={detail.content.name}
            alwaysShowTitle
            leading={
              // A Machine runs a Compose file; a platform Environment carries its platform's brand (lab d4, D11: no server glyph).
              platformRef ? <DeploymentEnvironmentMark size="page" platform={{ pluginId: platformRef.pluginId,
                title: platform?.title ?? t('projects.deployments.platformLink.platform') }} />
                : <PageHeaderMarkIcon name={runtime?.source.kind === 'host' || (!runtime && definition) ? 'hard-drives' : 'cloud'} />
            }
            titleAccessory={
              detail.environment.protection === 'production' ? (
                <StatusPill
                  variant="neutral"
                  hideDot
                  label={t('projects.deployments.production')}
                />
              ) : undefined
            }
            meta={meta}
            {...(detail.environment.capabilities.deploy
              ? {}
              : { description: t('projects.deployments.managersOnly') })}
            actions={
              props.phone ? (
                environmentMenu
              ) : (
                <View style={styles.headerActions}>
                  {deployButton}
                  {environmentMenu}
                </View>
              )
            }
            actionsPlacement="page"
            // The mark and the actions hang from the name's line, as on a Machine page, so a long name never
            // pushes the phone's ⋯ onto a row of its own.
            actionsLayout="hang"
          />

          <ItemGroup surface="none" header="none">
            <EnvironmentPageNavigation navigation={navigation} phone={props.phone} onSelect={selectPage} />
          </ItemGroup>
          {/* One attention slot under the tabs (R3): only the highest-precedence notice; lower ones stay in their rows. */}
          {attentionNotice}
          {tab === 'overview' ? (
            <>
              {deploymentAttentionLeaves(attention, 'secretWithdrawn') ? (
                <DeploymentSecretBindingsNotice bindings={detail.content.bindings} scope={props.lifetime?.scope ?? null}
                  controlTarget={{ serverId: props.serverId, environmentId: props.environmentId, machineIds,
                    active: props.demand.mounted && props.demand.visible && props.demand.focused }} />
              ) : null}
              {/* An untitled section, not header="none": it keeps one section gap below the notice slot's banner. */}
              {sourceMethod && platform && runtime ? <ItemGroup>
                <DeploymentSourceMethodChoice methods={platform.sourceMethods} value={sourceMethod}
                  testID="project-deployments.environment.sourceMethod" disabled={!ready || deploying || reviewPending}
                  onChange={(value) => setSourceMethod({ targetLinkId: runtime.id, value })} />
              </ItemGroup> : null}
              {/* Serving now (lab `envOv` hero, owner 22:35Z): the address, the serving version's labelled cells and the
                  last deploy's steps in one card; then the headline facts; then the Environment's agent actions. */}
              {activeReceipt ? (
                <>
                  <ItemGroup testID="project-deployments.environment.serving">
                    <DeploymentServingReceipt receipt={activeReceipt}
                      still={attention?.kind === 'latestFailed'}
                      address={liveUrl ? {
                        text: formatDeploymentLiveAddress(liveUrl),
                        // The Domain's own line, as the Domains tab says it, at the address it is about.
                        attention: liveAddress?.attention ? <DomainStateLine state={liveAddress.attention} route={null} /> : null,
                        actions: liveActions(liveUrl),
                      } : null}
                      byYou={deploymentActorIsViewer(activeReceipt.facts.actor, props.accountId)}
                      phone={props.phone}
                      onOpenReceipt={openServingReceipt} />
                  </ItemGroup>
                  {/* The headline facts stay plain cells on the page under the card (dEnvOv KEEP item 3), not a second card. */}
                  <ItemGroup header="none" surface="none" style={styles.factsGroup}>
                    <FactStrip
                      testID="project-deployments.environment.facts"
                      layout="columns" narrow={props.phone}
                      facts={overviewFacts(detail, services.length, activeReceipt.facts.retainedPreviousCount ?? null, activeReceipt.deployment.state)}
                    />
                  </ItemGroup>
                </>
              ) : (
                <ItemGroupDefaultSurfaceProvider value="flat">
                <ItemGroup testID="project-deployments.environment.serving">
                  {activeId && active.snapshot.status === 'unavailable' ? (
                    <SurfaceStateCard
                      testID="project-deployments.environment.serving.error"
                      size="line"
                      kind="error"
                      title={t('projects.deployments.servingErrorTitle')}
                      diagnosticCode={active.snapshot.failure?.code ?? null}
                      action={{
                        label: t('common.retry'),
                        testID: 'project-deployments.environment.serving.error.retry',
                        onPress: () => active.refresh(),
                      }}
                    />
                  ) : activeId ? (
                    // The serving version's own shape while its receipt reads (R5).
                    <SkeletonRows testID="project-deployments.environment.serving.loading" rows={2}
                      accessibilityLabel={t('common.loading')} />
                  ) : (
                    <Item
                      testID="project-deployments.environment.serving.none"
                      title={t('projects.deployments.nothingDeployedTitle')}
                      // The linked target decides what deploys it; only an unlinked Environment falls back to its definition.
                      subtitle={(runtime ? runtime.source.kind === 'plugin' : !definition)
                        ? t('projects.deployments.platformLink.nothingDeployedBody')
                        : knownMachine(machineIds[0])
                          ? t('projects.deployments.nothingDeployedBody', { machine: keepNamesWhole(knownMachine(machineIds[0])!) })
                          : t('projects.deployments.nothingDeployedBodyAny')}
                      mode="info"
                    />
                  )}
                </ItemGroup>
                </ItemGroupDefaultSurfaceProvider>
              )}
              {/* Before anything serves, the Environment's agent actions are the next step under the facts. */}
              {ready ? null : environmentAgentActions}
              {/* The kept order (pfc-redesign r4 dEnvOv KEEP item 3, owner-approved 11-13): Definition and Needs a
                  repository, Deployed definition, Data, Previews; what runs, triggers, push setup and CI follow. */}
              {detail.content.definition.kind === 'stored' ? <StoredDefinitionOverview
                revision={detail.content.definition.contentRevision}
                editable={environmentEditing !== null && detail.environment.capabilities.role === 'manager'}
                onOpen={() => openTab('settings')}
                onMove={environmentEditing?.actions.moveToRepository && detail.environment.capabilities.role === 'manager'
                  ? () => openTab('settings') : null} /> : null}
              {active.snapshot.value?.content.sourceIntent ? <DeploymentVersionComparison
                source={active.snapshot.value.content.sourceIntent} current={detail.content.definition}
                workspaceRef={props.workspaceRef} serverId={props.serverId} accountId={props.accountId} demand={props.demand} /> : null}
              <DeploymentDataCard scope={navigationScope} detail={detail} place={knownMachine(machineIds[0])}
                lifetime={props.lifetime} presented={props.demand.mounted && props.demand.visible && props.demand.focused}
                onOpen={props.onOpenDatabase}
                onBackups={() => openTab('settings', 'backups')}
                onAdd={() => { openAddDatabase?.(); }} />
              {/* A stored definition's own section already says previews follow a repository: one cause, said once
                  (PAGE-ACCEPT-176 R10-D9). */}
              {previewAvailability !== 'preview'
                && !(previewAvailability === 'needsRepository' && detail.content.definition.kind === 'stored') ? (
                // Previews are a section of their own (title, purpose, current state), never a lone card under Triggers.
                <ItemGroup testID="project-deployments.environment.overview.previewsSection"
                  title={t('projects.deployments.sectionPreviews')}
                  description={t('projects.deployments.sectionPreviewsDescription')}>
                  <Item testID="project-deployments.environment.overview.previews"
                    icon={<Icon name="git-pull-request" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                    title={previewAvailability === 'needsRepository'
                      ? t('projects.deployments.settingsSections.previewsNeedRepository')
                      : t('projects.deployments.settingsSections.previewEditor.configure')}
                    subtitle={previewAvailability === 'needsRepository' ? undefined
                      : t(previewAvailability === 'on'
                        ? 'projects.deployments.settingsSections.previewsOn'
                        : 'projects.deployments.settingsSections.previewsOff')}
                    onPress={previewAvailability === 'needsRepository' ? undefined : () => openTab('settings', 'previews')} />
                </ItemGroup>
              ) : null}
              {services.length > 0 ? (
                <ItemGroup
                  testID="project-deployments.environment.services"
                  title={t('projects.deployments.overviewStatus.whatRunsTitle')}
                  titleAccessory={<ManagedSectionCount count={services.length} />}
                  description={knownMachine(machineIds[0])
                    ? t('projects.deployments.overviewStatus.servicesRun', { machine: keepNamesWhole(knownMachine(machineIds[0])!) })
                    : t('projects.deployments.overviewStatus.servicesRunAny')}
                  surface="none"
                  action={machineIds.length === 1 ? (
                    <SectionActionButton
                      testID="project-deployments.environment.services.open"
                      // The description already names the Machine; the action says where it goes.
                      title={t('projects.deployments.openMachineServices')}
                      destination
                      onPress={() => router.push(machinePageHref({
                        door: 'rail', target: { machineId: machineIds[0]!, serverId: props.serverId }, tab: { id: 'services' },
                      }) as never)}
                    />
                  ) : undefined}
                >
                  <EnvironmentServiceRows
                    services={services}
                    serverId={props.serverId}
                    environmentId={props.environmentId}
                    // Row operations act on one Machine's live rows; several servers keep the rows as facts.
                    machineId={machineIds.length === 1 && runtime?.source.kind === 'host' ? machineIds[0]! : null}
                    machineName={machineLabel}
                    place={props.environmentTitle?.(props.environmentId) ?? detail.content.name}
                    targetLinkId={runtime?.id ?? null}
                    restart={machineOnline === false ? null : props.restart ?? null}
                    review={review}
                    active={props.demand.mounted && props.demand.visible}
                    onOpenLogs={logsOffered ? openLogs : null}
                    connections={connections}
                  />
                </ItemGroup>
              ) : null}
              {/* An app's own sign-in stays under What runs; a database's credentials belong to its Database page. */}
              {services.length > 0 && props.lifetime && !detail.content.template?.data?.length ? (
                  <DeploymentAdminLogin
                    template={detail.content.template ?? null}
                    bindings={detail.content.bindings}
                    scope={props.lifetime.scope}
                    active={props.demand.mounted && props.demand.visible}
                    servingUrl={adminServingUrl}
                    onOpenDomains={() => openTab('domains')}
                    onOpenServing={openAdminAddress}
                  />
              ) : null}
              <DeploymentPendingRequest pending={detail.pendingDeployment} serverId={props.serverId} />
              {detail.content.definition.kind === 'repository' ? <DeploymentPullRequestDeploy
                key={`${props.serverId}:${props.accountId}:${detail.environment.projectSourceId}:${projectSource.source?.source.revision ?? props.workspaceRef?.source?.revision}:${props.workspaceRef?.id}`}
                workspaceRef={props.workspaceRef} projectSourceId={detail.environment.projectSourceId}
                checkoutLedByVersion={active.snapshot.value?.content.sourceIntent?.kind === 'repository'}
                sourceRevision={projectSource.source?.source.revision ?? props.workspaceRef?.source?.revision ?? null}
                compose={detail.content.definition.compose} serverId={props.serverId} accountId={props.accountId}
                disabled={!ready || deployBlocked} onDeploy={async sourceIntent => {
                  if (!deploy || availability.kind !== 'ready') return;
                  // This press asked for an exact pull-request head; its refusal's remedy speaks to that head.
                  await press(() => deploy({ environmentId, targetLinkId: availability.targetLinkId, ...(onFailure ? { onFailure } : {}), sourceIntent, requestKey: randomUUID() }),
                    sourceIntent.pullRequestHead ? { request: { pullRequestHead: true } } : undefined);
                }} /> : null}
              {runtime && runtime.members.length > 1 ? (
                <EnvironmentServersSection
                  members={runtime.members}
                  memberVersions={detail.memberVersions}
                  failurePolicy={onFailure ? {
                    value: onFailure,
                    disabled: !ready || deploying || reviewPending,
                    onChange: value => setFailurePolicyDraft({ serverId: props.serverId, accountId: props.accountId,
                      environmentId: props.environmentId, value }),
                  } : null}
                  health={detail.healthAggregate ?? null}
                  machineName={machineName}
                  onManage={openFleet ?? (() => openTab('settings', 'servers-build'))}
                />
              ) : null}
              {/* Recent activity (lab `envOv`): the receipts before the serving one, as the shared Timeline. */}
              {recentReceipts.length > 0 ? (
                <ItemGroup
                  testID="project-deployments.environment.recent"
                  title={t('projects.deployments.overviewStatus.activityTitle')}
                  description={t('projects.deployments.overviewStatus.activityDescription')}
                  action={
                    <SectionActionButton
                      testID="project-deployments.environment.recent.history"
                      title={t('projects.deployments.history')}
                      destination
                      onPress={() => openTab('history')}
                    />
                  }
                >
                  <SectionContentRow>
                    <DeploymentActivityTimeline receipts={recentReceipts} accountId={props.accountId}
                      lifetime={props.lifetime ?? null} onOpen={openReceipt} />
                  </SectionContentRow>
                </ItemGroup>
              ) : null}
              {/* Once Deploy leads, they are a titled section of their own beside the Environment's other agent work. */}
              {ready ? environmentAgentActions : null}
              {/* Triggers (with push setup) and Deploy from CI close the Overview (dEnvOv KEEP lede). */}
              {triggerSubject ? (
                <View ref={automationsReveal.hostRef} collapsable={false}>
                <SubjectTriggersSection subject={triggerSubject} contextSubjects={backupContext}
                  subjectName={props.environmentTitle?.(props.environmentId) ?? detail.content.name}
                  deploymentEnvironment={{ serverId: props.serverId, projectSourceId: detail.environment.projectSourceId,
                    environmentId: detail.environment.id }}
                  deploymentSourceName={projectSource.source?.source.name}
                  sourceAudience={projectSource.audience}
                  controllerMachineId={detail.environment.controllerMachineId}
                  offlineStatedAbove={attention?.kind === 'machineOffline'
                    || (attention?.kind === 'controllerPaused' && triggerMachineId === detail.controller?.machineId)}
                  pushSetup={detail.content.definition.kind === 'repository' && detail.environment.runtimeTargetLinkId ? {
                    environment: { serverId: props.serverId, projectSourceId: detail.environment.projectSourceId,
                      environmentId: detail.environment.id },
                    targetLinkId: detail.environment.runtimeTargetLinkId,
                    project: { machineId: detail.environment.controllerMachineId, directory: '~' },
                    protection: detail.environment.protection,
                  } : undefined} />
                </View>
              ) : null}
              {/* Deploy from CI is a section of its own (lab ci/box): what it lets CI do, then the one token row. */}
              {ciInput ? (
                <ItemGroup testID="project-deployments.environment.ci.section"
                  title={t('projects.deployments.overviewStatus.ciTitle')}
                  description={t('projects.deployments.overviewStatus.ciDescription', { name: detail.content.name })}>
                  <Item title={t('projects.deployments.overviewStatus.ciTokensTitle')}
                    subtitle={t('projects.deployments.overviewStatus.ciTokensBody')}
                    showChevron={false} accessoryLayout="adaptive"
                    rightElement={<RoundButton size="small" display="secondary" testID="project-deployments.environment.ci"
                      title={t('projects.deployments.overviewStatus.manage')}
                      onPress={() => showDeploymentCiTokenSheet(ciInput)} />} />
                </ItemGroup>
              ) : null}
            </>
          ) : tab === 'history' ? (
            <DeploymentHistoryPage
              controller={props.controller}
              environmentId={props.environmentId}
              demand={props.demand}
              accountId={props.accountId}
              lifetime={props.lifetime ?? null}
              activeId={activeId}
              phone={props.phone}
              onOpen={openReceipt}
            />
          ) : tab === 'variables' ? (
            <>
            <DeploymentSecretRequests environmentId={props.environmentId} scope={props.lifetime?.scope ?? null}
              active={props.demand.mounted && props.demand.visible && props.demand.focused} />
            <DeploymentVariablesPanel
              controlTarget={{ serverId: props.serverId, environmentId: props.environmentId, machineIds,
                active: props.demand.mounted && props.demand.visible && props.demand.focused }}
              draft={bindings}
              phone={props.phone}
              environmentName={props.environmentTitle ?? noEnvironmentName}
              sealedOn={
                machineIds.length > 0 ? machineName(machineIds[0]!) : null
              }
              review={review}
              scope={props.lifetime?.scope ?? null}
              lifetime={props.lifetime ?? null}
              environmentId={props.environmentId}
              projectSourceId={detail.environment.projectSourceId}
              providerTargetLinkId={runtime?.source.kind === 'plugin' ? runtime.id : null}
              providerVariablesActive={props.demand.mounted && props.demand.visible && props.demand.focused}
              railwayDatabase={props.platformLink ? { detail, inspect: props.platformLink.inspectPlatformTarget } : undefined}
              secretRevisions={detail.secretRevisions}
              onDeploy={deployBlocked || !ready ? null : () => { void pressDeploy(); }}
              referenceTargets={referenceTargets}
              referenceEnvironments={props.referenceEnvironments}
              domainRead={{ controller: props.controller, demand: props.demand }}
            />
            </>
          ) : tab === 'domains' ? (
            <DeploymentDomainsPanel
              environment={detail.environment}
              builtInUrls={detail.builtInUrls ?? undefined}
              runtimeProjections={active.snapshot.value?.content.ownServer?.approvedInputBasis.runtimeProjections}
              controller={props.controller}
              environmentId={props.environmentId}
              healthSetup={props.lifetime && controllerMachineId
                ? { lifetime: props.lifetime, controllerMachineId } : null}
              demand={props.demand}
              phone={props.phone}
              ownMachineId={machineIds[0] ?? null}
              editing={props.domainActions ? {
                actions: props.domainActions,
                environmentRevision: detail.environment.revision,
                generatedDomains: platform?.generatedDomains === true,
                deployedServices: services.map((service) => service.name),
                content: detail.content,
                targetLink: runtime ? { id: runtime.id, revision: runtime.revision,
                  ...(runtime.source.kind === 'plugin' ? { provider: detail.targetLinks.find(row => row.targetLink.id === runtime.id)?.content ?? null } : {}) } : null,
                review,
                machine: knownMachine(controllerMachineId ?? undefined) ?? t('projects.deployments.aMachine'),
                onChanged: () => { void environment.refresh(); },
              } : null}
            />
          ) : tab === 'telemetry' ? (
            <DeploymentTelemetryPanel detail={detail} lifetime={props.lifetime ?? null}
              environmentName={detail.content.name} onChanged={() => { void environment.refresh(); }} />
          ) : tab === 'permissions' ? (
            <DeploymentPermissionsPanel
              detail={detail}
              lifetime={props.lifetime ?? null}
              machineName={machineName}
              editing={environmentEditing}
            />
          ) : (
            <>
            <DeploymentEnvironmentSettingsPanel
              detail={detail}
              previewAvailability={previewAvailability}
              previewBindings={previewBindings}
              definitionDocument={definitionDocument}
              phone={props.phone}
              controller={props.controller}
              demand={props.demand}
              machineName={machineName}
              environmentTitle={props.environmentTitle ?? noEnvironmentName}
              focusSection={isDeploymentEnvironmentSettingsSectionV1(settingsSection) ? settingsSection : null}
              onUnlink={disposition.canDelete ? openDisposition : null}
              onLink={openLink}
              onManageServers={openFleet}
              onChangeMachine={runtime?.source.kind === 'host' && runtime.state === 'configured'
                && !activeId && hasNoDeploymentHistory(runtime.id) ? openLink : null}
              onAddPlatform={openPlatform}
              retainedBackup={openRestore ? retainedBackup : null}
              onRestore={openRestore}
              review={review}
              lifetime={props.lifetime ?? null}
              editing={environmentEditing}
              onAddDatabase={openAddDatabase}
              onOpenDatabase={props.onOpenDatabase ?? null}
              referenceEnvironments={props.referenceEnvironments}
              onOpenMachineServices={(machineId) => router.push(machinePageHref({
                door: 'rail', target: { machineId, serverId: props.serverId }, tab: { id: 'services' },
              }) as never)}
            />
            </>
          )}
        </ItemList>
        <EnvironmentLogsCompanion
          open={navigation.companion.activeId === 'logs'}
          onClose={navigation.companion.close}
          services={services}
          service={logsService}
          serverId={props.serverId}
          environmentId={props.environmentId}
          machineId={machineIds.length === 1 && runtime?.source.kind === 'host' ? machineIds[0]! : null}
          machineName={machineLabel}
          machineNames={machineNames}
          controller={props.controller}
          deploymentId={buildDeploymentId}
          demand={props.demand}
          readLogs={props.readLogs ?? null}
          platformRuntime={platformRuntime}
          platformLogFollow={platform?.logFollow}
        />
        {props.phone && deployButton ? (
          <KeyboardStickyFooter>
            <PagePinnedBar>{deployButton}</PagePinnedBar>
          </KeyboardStickyFooter>
        ) : null}
      </View>
    );
  },
);

/** The page's approval continuation, as the Environment and receipt pages use it. */
export type DeploymentReviewHandle = Readonly<{
  /** The approval still waiting on a decision, if any. */
  pendingId: string | null;
  request: (artifactId: string) => void;
  open: () => void;
  /** Shared with every press and modal sheet; the page owns destination navigation. */
  openRecovery?: (destination: DeploymentFailureRecoveryDestinationV1, at?: DeploymentRecoveryTarget) => void;
}>;

/**
 * What the last Deploy, Roll back or Cancel press led to, in one banner: a review still open, accepted work, or a
 * refusal. `placement="inline"` draws it inside the pinned bar a phone pressed from.
 */
export function DeployOutcomeBanner(
  props: Readonly<{
    controller: DeploymentOutcomeController;
    /** Null for a platform target: no Machine to name, so the refusal's own code says why. */
    machine: string | null;
    /** The Machine a Machine-scoped remedy opens (its Setup), when the refusal concerns one runtime Machine. */
    machineId?: string | null;
    copy?: 'deploy' | 'rollback' | 'cancel' | 'domain' | 'domainAdd' | 'setting';
    placement?: 'inline';
  }>,
) {
  const { placement, controller } = props;
  const { outcome } = controller;
  if (!outcome || !hasDeploymentPressAttention(controller, props.copy)) return null;
  const rollback = props.copy === 'rollback';
  const cancel = props.copy === 'cancel';
  const domain = props.copy === 'domain' || props.copy === 'domainAdd' || props.copy === 'setting';
  const setting = props.copy === 'setting';
  if (outcome.kind === 'approval') {
    return (
      <AttentionBanner
        testID="project-deployments.outcome.approval"
        placement={placement}
        tone="neutral"
        title={t('projects.deployments.reviewWaitingTitle')}
        description={
          rollback
            ? t('projects.deployments.rollbackApprovalBody')
            : cancel
              ? t('projects.deployments.cancelApprovalBody')
              : domain
                ? t('projects.deployments.domainApprovalBody')
                : props.machine
                  ? t('projects.deployments.reviewWaitingBody', { machine: props.machine })
                  // A platform target has no Machine to name.
                  : t('projects.deployments.domainApprovalBody')
        }
        action={controller.openReview ? {
          label: t('projects.deployments.openReview'),
          onPress: controller.openReview,
        } : undefined}
      />
    );
  }
  if (outcome.kind === 'started') {
    return (
      <AttentionBanner
        testID="project-deployments.outcome.started"
        tone="neutral"
        title={t('projects.deployments.deployStartedTitle')}
        description={t('projects.deployments.deployStartedBody')}
      />
    );
  }
  if (outcome.kind !== 'refused') return null;
  // A cancel has no build to explain: an unsupported refusal reads as any other "couldn't cancel".
  const unsupported = outcome.reason === 'unsupported' && !cancel && !domain;
  const failure = outcome.failure ? presentActionFailureOutcome(outcome.failure, 'deployment') : null;
  // The recovery owner's remedy and route for this refusal (E4): a stored generic remedy never hides a typed cause.
  const typedRecovery = readDeploymentRefusalRecoveryV1(outcome.code, outcome.failure?.details, outcome.request);
  // The press's own request (an exact pull-request head) chose a more specific remedy than the refusal's stored one.
  const requestSpecific = outcome.request !== undefined
    && typedRecovery?.remedy !== readDeploymentRefusalRecoveryV1(outcome.code, outcome.failure?.details)?.remedy;
  // A failed step's logs are on the receipt the refusal names. Without one, this attempt left no step to inspect:
  // no action, and the sentence says why instead.
  const failedDeploymentId = DeploymentExecutionFailureDetailsV1Schema.safeParse(outcome.failure?.details).data?.deploymentId;
  const leadsNowhere = typedRecovery?.nextAction.destination === 'logs' && !failedDeploymentId;
  // The cure is this Environment's own Deploy, already on the page: the sentence names it, no second button.
  const ownDeploy = typedRecovery?.nextAction.destination === 'deploy';
  const recovery = leadsNowhere || ownDeploy ? null : typedRecovery;
  const recoveryMachineId = recovery?.nextAction.machineId
    ?? (recovery?.nextAction.destination === 'machines' ? props.machineId : undefined);
  const storedRemedy = failure?.technicalDetails.find(line => line.key === 'failure-remedy')?.value;
  const canonicalReason = failure && failure.reason !== storedRemedy && !requestSpecific && !ownDeploy ? failure.reason : null;
  const { openRecovery } = controller;
  // A refusal whose way forward is a review needs the person, not a retry of a failure: amber, paired with that review.
  const needsReview = recovery?.nextAction.destination === 'review';
  return (
    <AttentionBanner
      testID={`project-deployments.outcome.refused.${outcome.reason}`}
      placement={placement}
      tone={
        needsReview
          ? 'warning'
          : unsupported || outcome.reason === 'machine'
          ? 'neutral'
          : 'danger'
      }
      title={
        needsReview
          ? t('projects.deployments.reviewWaitingTitle')
          : unsupported
          ? t('projects.deployments.deployUnavailableTitle')
          : rollback
            ? t('projects.deployments.rollbackFailedTitle')
            : cancel
              ? t('projects.deployments.cancelFailedTitle')
              : setting
                ? t('projects.deployments.settingChangeFailedTitle')
                : props.copy === 'domainAdd'
                  ? t('projects.deployments.editors.domainAddFailedTitle')
                : domain
                  ? t('projects.deployments.domainChangeFailedTitle')
                : t('projects.deployments.deployFailedTitle')
      }
      description={
        canonicalReason ?? (outcome.reason === 'permission'
          ? t('projects.deployments.managersOnly')
          : outcome.reason === 'machine' && props.machine !== null
            ? t('projects.deployments.machineOffline', {
                machine: props.machine,
              })
            : unsupported && props.machine !== null
              ? t('projects.deployments.deployNeedsBuild', {
                  machine: props.machine,
                })
              : leadsNowhere ? t('projects.deployments.refusedBeforeLogs')
              : (ownDeploy ? typedRecovery?.remedy : recovery?.remedy) ?? failure?.reason ?? refusalConsequence(outcome.code))
      }
      {...(recovery?.nextAction.destination === 'review'
        ? { action: { label: recovery.nextAction.label, onPress: controller.retry } }
        : recovery && openRecovery ? { action: { label: recovery.nextAction.label,
          onPress: () => openRecovery(recovery.nextAction.destination,
            failedDeploymentId ? { deploymentId: failedDeploymentId }
              : recoveryMachineId ? { machineId: recoveryMachineId } : undefined) } } : {})}
      // The typed code is for support; the sentence says what it left. When the typed remedy is the sentence, the
      // stored recovery line would only repeat or contradict it.
      details={failure ? failure.technicalDetails.filter(line => !(line.key === 'failure-remedy' && (recovery || ownDeploy) && !canonicalReason))
        .map(line => `${line.label}: ${line.value}`) : [outcome.code]}
    />
  );
}

/**
 * What a refused press left, by its typed code. A press whose receipt settled failed or uncertain did change
 * something, so it never reads "Nothing changed": an uncertain one says so, a failed one lets the title speak.
 */
function refusalConsequence(code: string): string | undefined {
  if (code === 'outcome_unknown') return t('projects.deployments.unknownBody');
  if (code === 'deployment_failed' || code === 'cancelled') return undefined;
  return t('projects.deployments.nothingChanged');
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0 },
  phoneDeploy: { flexGrow: 1 },
  phoneSplit: { flexGrow: 1, alignSelf: 'stretch' },
  split: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  historyFilters: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingBottom: theme.space.s8,
  },
  historyTokens: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
  historyTokenRow: { paddingBottom: theme.space.s8 },
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
  // The row already insets its bottom content; the strip only keeps its distance from the commit line.
  factsLine: { color: theme.colors.text.secondary },
  mono: Typography.mono(),
  // The facts are their own card a grid gap under the receipt (lab `envOv`), not a second half of it.
  factsGroup: { marginTop: PAGE_LIST_METRICS.cardGapPx },
  cellQuiet: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  serviceByline: { minWidth: 0, maxWidth: '100%', alignSelf: 'stretch' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
  rowMetaText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  // The age column keeps one width so every row's duration lines up beside it.
  rowAge: { minWidth: theme.space.s48 + theme.space.s16, textAlign: 'right' },
}));

type DeploymentService = Readonly<{ name: string; reference: string | null }>;
const NO_SERVICES: readonly DeploymentService[] = [];
const LOGS_COMPANION: readonly EnvironmentCompanionId[] = Object.freeze(['logs']);
const NO_COMPANION: readonly EnvironmentCompanionId[] = Object.freeze([]);

/**
 * What the receipt runs: its Compose services in order. A pulled image keeps its name and tag (the digest
 * stays on the receipt); an image this deploy built has no reference, so its row says where it was built.
 */
function deploymentServices(content: DeploymentContentV1): readonly DeploymentService[] {
  const names = content.ownServer?.approvedInputBasis.services
    ?? [...new Set(content.images.map((image) => image.service))];
  return names.map((name) => {
    const reference = content.images.find((candidate) => candidate.service === name)?.registryReference;
    return { name, reference: reference ? reference.split('@')[0]!.split('/').pop()! : null };
  });
}

/** The four headline facts under the serving version (lab `fc-facts`): health, services, rollout, rollback. */
function overviewFacts(detail: DeploymentEnvironmentDetailV1, serviceCount: number, kept: number | null,
  servingState: DeploymentReceiptHeaderV1['state']): FactStripFact[] {
  const health = detail.healthAggregate;
  const facts: FactStripFact[] = [{
    key: 'health',
    testID: 'project-deployments.environment.facts.health',
    label: t('projects.deployments.healthTitle'),
    ...deploymentHealthFact(health, servingState),
  }];
  if (serviceCount > 0) {
    facts.push({ key: 'services', label: t('projects.deployments.servicesTitle'),
      value: t('projects.deployments.servicesFact', { count: serviceCount }) });
  }
  if (detail.content.ownServer) {
    facts.push({ key: 'rollout', label: t('projects.deployments.sectionRollout'),
      value: detail.content.ownServer.rollout === 'startFirst'
        ? t('projects.deployments.rolloutFactStartFirst')
        : t('projects.deployments.rolloutFactRecreate') });
  }
  if (kept !== null) facts.push({ key: 'kept', label: t('projects.deployments.keptForRollback'),
    value: kept > 0 ? t('projects.deployments.keptCount', { count: kept }) : t('projects.deployments.keptNone') });
  return facts;
}

/** One quiet facts line: an optional state word in its tone, the short commit in mono, then the rest. */
function ReceiptFactsLine(props: Readonly<{
  sha: string | null;
  facts: readonly string[];
  lead?: Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null;
}>) {
  const parts: React.ReactNode[] = [];
  const push = (node: React.ReactNode) => {
    if (parts.length > 0) parts.push(' · ');
    parts.push(node);
  };
  if (props.lead) {
    // The shared status word owns the tone's ink (FIDELITY G10); an untoned lead stays plain text.
    push(props.lead.tone ? <StatusWord key="lead" variant={props.lead.tone === 'danger' ? 'danger' : 'attention'} label={props.lead.text} />
      : <Text key="lead">{props.lead.text}</Text>);
  }
  if (props.sha) push(<Text key="sha" style={styles.mono}>{props.sha}</Text>);
  for (const fact of props.facts) push(fact);
  return <Text variant="body" style={styles.factsLine} numberOfLines={1}>{parts}</Text>;
}

/** "by you · 2 hours ago · took 49 s": who (the caller's actor label, or nothing when unknown), when, how long. */
export function describeReceipt(
  receipt: DeploymentReceiptHeaderV1,
  who: string | null,
): string {
  const parts: string[] = [];
  if (who) parts.push(who);
  parts.push(
    formatRelativeTime(deploymentReceiptAtMs(receipt)),
  );
  const duration = deploymentDurationMs(receipt);
  if (duration !== null)
    parts.push(
      t('projects.deployments.took', {
        duration: formatElapsedDuration(duration),
      }),
    );
  return parts.join(' · ');
}

const DeploymentReceiptRow = React.memo(function DeploymentReceiptRow(
  props: Readonly<{
    receipt: DeploymentReceiptHeaderV1 & Readonly<{ title?: string; failure?: DeploymentReceiptFailureV1 | null;
      source?: DeploymentReviewRevisionV1 | null; steps?: readonly DeploymentStepV1[] }>;
    live: boolean;
    /** Who acted, first on the facts line (dHist KEEP "by"): "by you", a name, an agent or a workflow; never guessed. */
    actor: string | null;
    phone: boolean;
    /** The shared clock for the row and its History day group. */
    historyAsOfMs?: number;
    /** Stable from the producer; the row binds its own id. */
    onOpen: (deploymentId: string) => void;
  }>,
) {
  const { receipt } = props;
  const duration = deploymentDurationMs(receipt);
  const receiptAtMs = deploymentReceiptAtMs(receipt);
  const age = props.historyAsOfMs === undefined
    ? formatRelativeTime(receiptAtMs)
    : formatDayGroupedAge(receiptAtMs, props.historyAsOfMs);
  // A settled success says nothing; trouble and work in progress lead the facts line in their tone. "Running, not
  // verified" is about what serves now, so only the live row says it; a superseded run reads as the run it was (D17).
  const settledPast = !props.live && receipt.state === 'running_unverified';
  const lead = receipt.title && !settledPast ? deploymentHistoryLead(receipt, receipt.failure) : null;
  const facts = props.actor ? [props.actor] : [];
  // A phone keeps the title's width: duration and age join the facts line instead of a right column.
  if (props.phone) facts.push(...(duration !== null ? [formatElapsedDuration(duration)] : []), age);
  // A failed or running deploy shows where it is or stopped (dHist): the compact strip with its caption. A settled
  // success keeps the single glyph.
  const strip = (receipt.state === 'failed' || receipt.state === 'running') && receipt.steps && receipt.steps.length > 0
    ? receipt.steps : null;
  return (
    <Item
      testID={`project-deployments.receipt.row.${receipt.id}`}
      leftElement={
        <WorkStatusGlyph
          status={deploymentWorkStatus(settledPast ? 'succeeded' : receipt.state)}
          testIDSuffix={`deployment-${receipt.id}`}
        />
      }
      // The receipt's own title names what was deployed; without one its state is the title.
      // What the operation did to which version ("Rolled back to 302cf72"), so same-revision rows read apart.
      title={receipt.source ? deploymentReceiptTitle(receipt, deploymentRevisionLabel(receipt.source))
        : receipt.title ?? deploymentStateLabel(receipt.state)}
      accessibilityRole="button"
      titleAccessory={
        props.live ? (
          <StatusPill
            variant="neutral"
            hideDot
            label={t('projects.deployments.live')}
          />
        ) : undefined
      }
      subtitle={lead || facts.length > 0 ? <ReceiptFactsLine sha={null} lead={lead} facts={facts} /> : undefined}
      bottomElement={strip ? (
        <DeploymentStepStrip variant="compact" captioned steps={strip} testID={`project-deployments.receipt.row.${receipt.id}.steps`} />
      ) : undefined}
      bottomElementInset="text"
      rightElement={props.phone ? undefined : (
        <View style={styles.rowMeta}>
          {duration !== null ? (
            <Text variant="meta" style={styles.rowMetaText}>{formatElapsedDuration(duration)}</Text>
          ) : null}
          <Text variant="meta" style={[styles.rowMetaText, styles.rowAge]}>{age}</Text>
        </View>
      )}
      rightElementYields
      onPress={() => props.onOpen(receipt.id)}
    />
  );
});

/**
 * History (lab d1 `history`, P2): every receipt, newest first, narrowed at the read owner by state, who started it
 * and operation. The filter button opens the shared condition editor; what is on reads as tokens beneath it. The
 * tab names the list, so it carries no section title.
 */
type HistoryOutcome = 'all' | 'succeeded' | 'failed';
const HISTORY_STATED_FIELDS: readonly string[] = Object.freeze(['state']);
/** The History registry's field marks in the filter editor. */
const HISTORY_FILTER_FIELD_ICONS = Object.freeze({ state: 'circle-half', actorAccountId: 'user-circle', operation: 'lightning' } as const);

/** Read nothing without a lifetime: the actor hook is disabled then, so this scope is never queried. */
const NO_ACTOR_SCOPE: ServerAccountScope = Object.freeze({ serverId: '', accountId: '' });

function DeploymentHistoryPage(
  props: Readonly<{
    controller: DeploymentReadControllerV1;
    environmentId: string;
    demand: DeploymentReadDemandV1;
    accountId: string;
    lifetime: ServerAccountScopeLifetime | null;
    activeId: string | null;
    phone: boolean;
    onOpen: (deploymentId: string) => void;
  }>,
) {
  const [filters, setFilters] = React.useState<DeploymentHistoryFilter>(EMPTY_DEPLOYMENT_HISTORY_FILTER);
  const history = useDeploymentHistory(props.controller, props.environmentId, props.demand, filters);
  const registry = React.useMemo(() => createDeploymentHistoryFilterRegistry(props.accountId), [props.accountId]);
  const bindings = React.useMemo(() => ({ fields: {
    state: { label: t('projects.deployments.receipt.state'), valueOptions: registry[0]!.conditions!.valueOptions
      .map(value => ({ value, label: deploymentStateLabel(value as DeploymentReceiptHeaderV1['state']) })) },
    actorAccountId: { label: t('projects.deployments.receipt.actor'),
      valueOptions: [{ value: props.accountId, label: t('projects.deployments.receipt.you') }] },
    operation: { label: t('projects.deployments.receipt.operation'), valueOptions: registry[2]!.conditions!.valueOptions
      .map(value => ({ value, label: deploymentOperationLabel(value as DeploymentReceiptHeaderV1['operation']) })) },
  } }), [registry, props.accountId]);
  const header = useCollectionConditionHeader({
    testIDPrefix: 'project-deployments.history',
    registry,
    bindings,
    fieldIcons: HISTORY_FILTER_FIELD_ICONS,
    filters,
    setFilters,
    baseFilter: EMPTY_DEPLOYMENT_HISTORY_FILTER,
    // Outcome is what people narrow History by most: one segmented press, so it is not also a token.
    // A rarer state chosen in the editor (Cancelled…) stays a token, since the segment can't say it.
    statedFields: filters.state === undefined || filters.state === 'succeeded' || filters.state === 'failed'
      ? HISTORY_STATED_FIELDS : undefined,
  });
  const filtered = Object.keys(filters).length > 0;
  const outcome: HistoryOutcome = filters.state === 'succeeded' || filters.state === 'failed' ? filters.state : 'all';
  const receipts = history.result.items;
  // Who acted, through the one actor display owner (as Recent activity and the Services rows read it).
  const actors = React.useMemo(() => receipts.map((receipt) => receipt.actor), [receipts]);
  const presentations = useDeploymentActorPresentations({ actors, scope: props.lifetime?.scope ?? NO_ACTOR_SCOPE,
    accountLifetime: props.lifetime, active: props.lifetime !== null });
  const actorById = React.useMemo(() => new Map(receipts.map((receipt, index) => {
    const presentation = presentations[index];
    return [receipt.id, deploymentActorIsViewer(receipt.actor, props.accountId) ? t('projects.deployments.byYou')
      : presentation ? deploymentActorLabel(presentation, receipt.actor, props.accountId) : null] as const;
  })), [presentations, props.accountId, receipts]);
  // Newest first, by local day, through the one day-grouping owner the Session lists use.
  const { days, nowMs } = React.useMemo(() => {
    const nowMs = Date.now();
    return { days: buildSessionListDateGroups({ items: receipts, readMeaningfulActivityAt: deploymentReceiptAtMs, nowMs }), nowMs };
  }, [receipts]);
  return (
    <>
      {/* The filter line stands on the list's column, the same inset as the day sections below it. */}
      <ItemGroup surface="none" header="none">
      <View style={styles.historyFilters}>
        <View style={styles.historyTokens}>
          <SegmentedTabBar<HistoryOutcome> role="radiogroup" segmentSizing="content"
            accessibilityLabel={t('projects.deployments.receipt.state')}
            testIDPrefix="project-deployments.history.outcome" activeTabId={outcome}
            tabs={[{ id: 'all', label: t('projects.deployments.receipt.allStates') },
              { id: 'succeeded', label: deploymentStateLabel('succeeded') },
              { id: 'failed', label: deploymentStateLabel('failed') }]}
            onSelectTab={(id) => setFilters(current => {
              const { state: _state, ...rest } = current;
              return id === 'all' ? rest : { ...rest, state: id };
            })} />
        </View>
        {header.filterButton}
      </View>
      {header.tokenRow ? <View style={styles.historyTokenRow}>{header.tokenRow}</View> : null}
      </ItemGroup>
      {header.editorOverlay}
      {days.map((day) => (
        <ItemGroup key={day.dateKey} testID={`project-deployments.environment.history.day.${day.dateKey}`} title={day.title}>
          {day.items.map((receipt) => (
            <DeploymentReceiptRow
              key={receipt.id}
              receipt={receipt}
              live={receipt.id === props.activeId}
              actor={actorById.get(receipt.id) ?? null}
              historyAsOfMs={nowMs}
              phone={props.phone}
              onOpen={props.onOpen}
            />
          ))}
        </ItemGroup>
      ))}
      <ItemGroup
        testID="project-deployments.environment.history"
        header="none"
      >
        {history.hasPreviousPage || history.hasNextPage ? (
          <View style={styles.paging}>
            {history.hasPreviousPage ? (
              <SectionActionButton
                testID="project-deployments.environment.history.newer"
                title={t('projects.deployments.pageNewer')}
                icon="caret-left"
                onPress={history.previousPage}
              />
            ) : null}
            {history.hasNextPage ? (
              <SectionActionButton
                testID="project-deployments.environment.history.older"
                title={t('projects.deployments.pageOlder')}
                icon="caret-right"
                onPress={history.nextPage}
              />
            ) : null}
          </View>
        ) : null}
        {filtered && history.result.status === 'empty' ? (
          // Nothing matches the narrowing: one line that says so, with Clear, never the empty-history state.
          <SurfaceStateCard
            testID="project-deployments.environment.history.filteredEmpty"
            size="line"
            kind="empty"
            title={t('projects.deployments.receipt.noMatches')}
            action={{
              label: t('projects.deployments.receipt.clear'),
              testID: 'project-deployments.environment.history.clear',
              onPress: () => setFilters(EMPTY_DEPLOYMENT_HISTORY_FILTER),
            }}
          />
        ) : (
          <DeploymentTabState
            result={history.result}
            testID="project-deployments.environment.history"
            errorTitle={t('projects.deployments.historyErrorTitle')}
            emptyTitle={t('projects.deployments.historyEmpty')}
          />
        )}
      </ItemGroup>
    </>
  );
}

/** Deploy's chevron (lab d1): Redeploy what is live. "Deploy a commit…" joins it when a commit picker exists. */
function DeployMoreMenu(
  props: Readonly<{
    disabled: boolean;
    phone: boolean;
    /** Deploy's own emphasis, so the split control reads as one. */
    display: 'secondary' | undefined;
    tint: string;
    onRedeploy: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      {
        id: 'redeploy',
        testID: 'project-deployments.environment.deploy.more.redeploy',
        title: t('projects.deployments.redeployLive'),
        subtitle: t('projects.deployments.redeployLiveHint'),
        icon: (
          <Icon
            name="arrow-clockwise"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
    ],
    [theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('projects.deployments.moreWaysToDeploy')}
      onSelect={(id) => {
        if (id === 'redeploy') props.onRedeploy();
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID="project-deployments.environment.deploy.more"
          size="normal"
          joinedEdge="start"
          display={props.display}
          accessibilityLabel={t('projects.deployments.moreWaysToDeploy')}
          disabled={props.disabled}
          onPress={toggle}
          leading={
            <Icon
              name="caret-down"
              size={14}
              color={props.tint}
            />
          }
        />
      )}
    />
  );
}

/** The header's ⋯ (lab d1): the Environment's rare operations, each leading to the page that owns it. */
function EnvironmentMenu(
  props: Readonly<{
    /** Roll back… leads to History; absent while nothing earlier served (D11). */
    onOpenHistory?: () => void;
    onOpenSettings: () => void;
    onDuplicate?: () => void;
    move: Readonly<{ kind: 'ready'; open: () => void }> | Extract<DeploymentMoveEligibility, { kind: 'unavailable' }>;
    /** The Logs companion beside the page: checked while it shows, and pressing again closes it. */
    logs?: Readonly<{ open: boolean; toggle: () => void }>;
    /** "Delete Staging…", last and destructive; null where this viewer cannot delete it. */
    deleteTitle: string | null;
    onDelete: () => void;
    /** Pin keeps it at the top of the person's Services column; Unpin takes it off (projects.services.pin). */
    pin?: Readonly<{ pinned: boolean; toggle: () => void }>;
    /**
     * A preview's Deploy to Production (deploy auto-mode U9): Deploy an app on this Project's code, its Review showing
     * this preview's address and health before the person deploys Production.
     */
    deployProduction?: Readonly<{ projectSourceId: string; previewEnvironmentId: string }>;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const openNewApp = useOpenNewApp();
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      ...(props.deployProduction ? [{ id: 'deployProduction', testID: 'project-deployments.environment.menu.deployProduction',
        title: t('projects.deployments.menuDeployProduction'),
        icon: <Icon name="rocket" size={16} color={theme.colors.text.secondary} /> }] : []),
      ...(props.pin ? [{ id: 'pin', testID: 'project-deployments.environment.menu.pin',
        title: props.pin.pinned ? t('projects.actions.unpin') : t('projects.actions.pin'),
        icon: <Icon name={props.pin.pinned ? 'push-pin-slash' : 'push-pin'} size={16} color={theme.colors.text.secondary} /> }] : []),
      ...(props.onDuplicate ? [{ id: 'duplicate', testID: 'project-deployments.environment.menu.duplicate',
        title: t('projects.deployments.copy.menu'),
        icon: <Icon name="copy" size={16} color={theme.colors.text.secondary} /> }] : []),
      ...(props.move?.kind === 'ready' ? [{ id: 'move', testID: 'project-deployments.environment.menu.move',
        title: t('projects.deployments.move.menu'),
        icon: <Icon name="arrow-right" size={16} color={theme.colors.text.secondary} /> }] : []),
      ...(props.logs ? [{ id: 'logs', testID: 'project-deployments.environment.menu.logs',
        title: t('projects.deployments.overviewStatus.logsTitle'), checked: props.logs.open,
        icon: <Icon name="article" size={16} color={theme.colors.text.secondary} /> }] : []),
      ...(props.onOpenHistory ? [{
        id: 'history',
        testID: 'project-deployments.environment.menu.history',
        title: t('projects.deployments.menuRollBack'),
        subtitle: t('projects.deployments.menuRollBackHint'),
        icon: (
          <Icon
            name="clock-counter-clockwise"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      }] : []),
      {
        id: 'settings',
        testID: 'project-deployments.environment.menu.settings',
        title: t('projects.deployments.menuEdit'),
        icon: (
          <Icon
            name="sliders-horizontal"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
      ...(props.deleteTitle
        ? [{
            id: 'delete',
            testID: 'project-deployments.environment.menu.delete',
            title: props.deleteTitle,
            destructive: true,
            icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
          }]
        : []),
    ],
    [Boolean(props.deployProduction), props.deleteTitle, props.onDuplicate, props.move?.kind, props.onOpenHistory, props.logs?.open, Boolean(props.logs), props.pin?.pinned, Boolean(props.pin), theme.colors.state.danger.foreground, theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => {
        if (id === 'deployProduction' && props.deployProduction) openNewApp(null, null, props.deployProduction);
        else if (id === 'pin') props.pin?.toggle();
        else if (id === 'history') props.onOpenHistory?.();
        else if (id === 'duplicate') props.onDuplicate?.();
        else if (id === 'move' && props.move?.kind === 'ready') props.move.open();
        else if (id === 'logs') props.logs?.toggle();
        else if (id === 'settings') props.onOpenSettings();
        else if (id === 'delete') props.onDelete();
      }}
      trigger={({ toggle }) => (
        <IconButton
          testID="project-deployments.environment.menu"
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        />
      )}
    />
  );
}

/**
 * Servers (P1 §2, Lab 1 option A): one row per member of a several-server Environment. Healthy rows are quiet; only a
 * down, degraded or joining member carries a sentence, and how many are down reads in the description.
 */
function EnvironmentServersSection(
  props: Readonly<{
    members: readonly Readonly<{ machineId: string; state: 'joining' | 'active' }>[];
    memberVersions: import('@happier-dev/deployments').DeploymentEnvironmentReadDetailV1['memberVersions'];
    failurePolicy: Readonly<{
      value: DeploymentOnFailureV1; disabled: boolean; onChange: (value: DeploymentOnFailureV1) => void;
    }> | null;
    health: DeploymentEnvironmentDetailV1['healthAggregate'] | null;
    machineName: (machineId: string) => string;
    onManage: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const count = props.members.length;
  const down = props.health?.down ?? 0;
  return (
    <ItemGroup
      testID="project-deployments.environment.servers"
      title={t('projects.deployments.overviewStatus.serversTitle')}
      titleAccessory={<ManagedSectionCount count={count} />}
      description={down > 0
        ? t('projects.deployments.overviewStatus.serversDown', { down, count })
        : t('projects.deployments.overviewStatus.serversDescription', { count })}
      action={
        <SectionActionButton
          testID="project-deployments.environment.servers.manage"
          title={t('projects.deployments.overviewStatus.manage')}
          destination
          onPress={props.onManage}
        />
      }
    >
      {props.members.map((member) => {
        const status = props.health?.members.find((row) => row.machineId === member.machineId)?.status;
        const sentence = member.state === 'joining'
          ? t('projects.deployments.overviewStatus.joining')
          : status === 'down' ? t('projects.deployments.healthDown')
            : status === 'degraded' ? t('projects.deployments.healthDegraded')
              : props.memberVersions[member.machineId]?.behind ? t('projects.deployments.overviewStatus.behind') : undefined;
        return (
          <Item
            key={member.machineId}
            testID={`project-deployments.environment.servers.${member.machineId}`}
            icon={<Icon name="hard-drives" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
            title={props.machineName(member.machineId)}
            subtitle={sentence}
            mode="info"
          />
        );
      })}
      {props.failurePolicy ? <SegmentedChoiceItem<DeploymentOnFailureV1>
        testID="project-deployments.environment.failurePolicy"
        testIDPrefix="project-deployments.environment.failurePolicy"
        title={t('projects.deployments.receipt.policy')}
        subtitle={t('projects.deployments.receipt.policyDescription')}
        options={[
          { id: 'rollbackAll', label: t('projects.deployments.receipt.rollbackAll') },
          { id: 'keepPartial', label: t('projects.deployments.receipt.keepPartial') },
        ]}
        value={props.failurePolicy.value}
        onChange={props.failurePolicy.onChange}
        disabled={props.failurePolicy.disabled}
      /> : null}
    </ItemGroup>
  );
}

type ServiceRestartState = 'idle' | 'running' | 'approval' | 'failed' | 'unknown' | 'unsupported';

/**
 * What runs (lab `envOv`, P1 §3): the serving services as the shared Collection's list with columns, each with its
 * mark, name and what it is, where it is reached, its memory now and its state, and its ⋯: Restart
 * (`deployments.restart`), Run a command… (the shared sheet, `machines.services.exec`) and Open on the Machine, whose
 * service page holds its logs. The live rows come from the Machine's one admitted services list, read only while this
 * section is shown; a service the list doesn't know yet keeps its row with an em dash.
 */
type EnvironmentServiceItem = Readonly<{
  service: DeploymentService;
  row: MachineServiceRowV1 | null;
  serves: readonly string[];
  stores: readonly string[];
}>;
type ServiceRestartFeedback = Readonly<{ state: ServiceRestartState; code: string | null }>;
const NO_RESTART_FEEDBACK: ReadonlyMap<string, ServiceRestartFeedback> = new Map();

const serviceRowOf = (item: EnvironmentServiceItem) => item.row;

function EnvironmentServiceRows(
  props: Readonly<{
    services: readonly DeploymentService[];
    serverId: string;
    environmentId: string;
    machineId: string | null;
    machineName: string;
    place: string;
    targetLinkId: string | null;
    restart: ReturnType<typeof createDeploymentActions>['restart'] | null;
    review: DeploymentReviewHandle;
    active: boolean;
    /** Opens the Logs companion on this service (P11); null where it has nothing to show. */
    onOpenLogs: ((service: string) => void) | null;
    /** Declared Environment connections; a row names only the edges that name its service. */
    connections: readonly DeploymentConnection[];
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId ?? '',
    environmentId: props.environmentId, active: props.active && props.machineId !== null });
  const rows = props.machineId ? list.rows : null;
  const [feedback, setFeedback] = React.useState(NO_RESTART_FEEDBACK);
  const onFeedback = useEventCallback((service: string, next: ServiceRestartFeedback) => setFeedback((current) => {
    const copy = new Map(current);
    if (next.state === 'idle' || next.state === 'running') copy.delete(service); else copy.set(service, next);
    return copy;
  }));
  const items = React.useMemo((): readonly EnvironmentServiceItem[] => props.services.map((service) => ({
    service,
    row: rows?.find((row) => row.deployment?.service.composeService === service.name) ?? null,
    ...serviceConnections(props.connections, service.name),
  })), [props.services, rows, props.connections]);
  const { machineId, serverId } = props;
  const openOnMachine = React.useCallback((item: EnvironmentServiceItem) => item.row && machineId ? () => router.push(machinePageHref({
    door: 'rail', target: { machineId, serverId }, tab: { id: 'services', page: 'service', service: item.row!.serviceId },
  }) as never) : null, [machineId, router, serverId]);
  const model = useHappierCollection<EnvironmentServiceItem>({
    items,
    keyOf: serviceItemKey,
    openKey: null,
    onOpenChange: (key) => {
      const item = key === null ? undefined : items.find((candidate) => candidate.service.name === String(key));
      if (item) openOnMachine(item)?.();
    },
  });
  const anatomy = React.useMemo<CollectionAnatomy<EnvironmentServiceItem>>(() => ({
    glyph: (item) => <Icon name={item.row ? machineServiceIcon(item.row) : 'cube'} size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
    title: (item) => item.service.name,
    // What it is, then (on a phone, where the columns drop) where it is reached; volumes always stay on this line.
    byline: (item, layout) => <EnvironmentServiceByline item={item} columns={layout?.fieldColumns === true} />,
    fields: [
      { key: 'reachedAt', title: t('projects.deployments.overviewStatus.columnReachedAt'), minWidth: 160, priority: 3, listColumn: true,
        render: (item) => item.serves.length > 0
          ? <Text variant="meta" style={[styles.mono, styles.cellQuiet]} numberOfLines={1}>{item.serves.join(', ')}</Text>
          : <Text variant="meta" style={styles.cellQuiet}>—</Text> },
      // Memory and State come from the service owner, so a stop the person asked for reads as that stop (FIDELITY G10).
      ...machineServiceColumnFields<EnvironmentServiceItem>(serviceRowOf).filter((field) => field.key === 'memory'),
      machineServiceStateField<EnvironmentServiceItem>(serviceRowOf),
    ],
    action: (item) => (
      <EnvironmentServiceMenu item={item} serverId={props.serverId} environmentId={props.environmentId} machineId={props.machineId}
        machineName={props.machineName} place={props.place} targetLinkId={props.targetLinkId} restart={props.restart}
        review={props.review} onRestarted={list.refresh} onOpenLogs={props.onOpenLogs} openOnMachine={openOnMachine(item)}
        onFeedback={onFeedback} />
    ),
    accessibilityLabel: (item) => item.row ? `${item.service.name}, ${machineServiceStateLabel(item.row)}` : item.service.name,
    testID: (item) => `project-deployments.environment.services.${item.service.name}`,
    columnTitles: { title: t('machineServices.columns.service') },
  }), [list.refresh, onFeedback, openOnMachine, props.environmentId, props.machineId, props.machineName, props.onOpenLogs,
    props.place, props.restart, props.review, props.serverId, props.targetLinkId, theme.colors.text.secondary]);
  return (
    <>
      <CoreCollectionScope>
          <Collection<EnvironmentServiceItem>
            testID="project-deployments.environment.services.table"
            model={model}
            anatomy={anatomy}
            accessibilityLabel={t('projects.deployments.overviewStatus.whatRunsTitle')}
            presentation="list"
            detail="none"
            scroll="page"
            minListWidth={0}
            minDetailWidth={0}
            preferredListRatio={1}
          />
      </CoreCollectionScope>
      {[...feedback].map(([service, { state, code }]) => (
        <SurfaceStateCard
          key={service}
          testID={`project-deployments.environment.services.${service}.restart.${state}`}
          size="line"
          kind={state === 'approval' ? 'loading' : 'warning'}
          diagnosticCode={state === 'failed' ? code : null}
          title={state === 'approval' ? t('machineServices.control.approval')
            : state === 'unknown' ? t('machineServices.control.unknown', { machine: props.machineName })
              : state === 'unsupported' ? t('machineServices.control.unsupported', { machine: props.machineName, service })
                : t('machineServices.control.failed', { service })}
        />
      ))}
    </>
  );
}

const serviceItemKey = (item: EnvironmentServiceItem) => item.service.name;

/** A service's declared Domains and volume mounts; Environment-level edges stay on their own cards. */
function serviceConnections(connections: readonly DeploymentConnection[], service: string): Pick<EnvironmentServiceItem, 'serves' | 'stores'> {
  return {
    serves: connections.filter(edge => edge.kind === 'domain' && edge.service === service).map(edge => edge.resource),
    stores: connections.filter(edge => edge.kind === 'volume' && edge.service === service).map(edge => edge.resource),
  };
}

function EnvironmentServiceByline(props: Readonly<{ item: EnvironmentServiceItem; columns: boolean }>) {
  const { service, serves, stores } = props.item;
  const connections = [
    ...(!props.columns && serves.length ? [t('projects.deployments.overviewStatus.serviceServes', { hosts: serves.join(', ') })] : []),
    ...(stores.length ? [t('projects.deployments.overviewStatus.serviceStores', { paths: stores.join(', ') })] : []),
  ].join(' · ');
  return (
    <View style={styles.serviceByline}>
      {service.reference
        ? <Text variant="meta" style={[styles.cellQuiet, styles.mono]} numberOfLines={1}>{service.reference}</Text>
        : <Text variant="meta" style={styles.cellQuiet} numberOfLines={1}>{t('projects.deployments.serviceBuiltHere')}</Text>}
      {connections ? <Text testID={`project-deployments.environment.services.${service.name}.connections`}
        variant="meta" style={styles.cellQuiet} numberOfLines={1}>{connections}</Text> : null}
    </View>
  );
}

function EnvironmentServiceMenu(
  props: Readonly<{
    item: EnvironmentServiceItem;
    serverId: string;
    environmentId: string;
    machineId: string | null;
    machineName: string;
    place: string;
    targetLinkId: string | null;
    restart: ReturnType<typeof createDeploymentActions>['restart'] | null;
    review: DeploymentReviewHandle;
    onRestarted: () => Promise<void>;
    onOpenLogs: ((service: string) => void) | null;
    openOnMachine: (() => void) | null;
    /** The restart's outcome line lives under the list, keyed by service; the sentence says what it left. */
    onFeedback: (service: string, feedback: ServiceRestartFeedback) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { machineId, onFeedback } = props;
  const { row, service } = props.item;
  // The refusal's typed code stays behind Details.
  const setRestartState = (state: ServiceRestartState, code: string | null = null) => onFeedback(service.name, { state, code });
  const generation = row?.generation ?? null;
  const restartInput = row?.deployment && generation && machineId && props.targetLinkId && row.capabilities.restart ? {
    environmentId: props.environmentId, deploymentId: row.deployment.deploymentId, targetLinkId: props.targetLinkId,
    machineId, installationId: row.deployment.installationId, service: row.deployment.service, expectedGeneration: generation,
  } : null;
  const { restart, review, onRestarted } = props;
  const pressRestart = restart && restartInput ? () => {
    setRestartState('running');
    void restart(restartInput).then((result) => {
      setRestartState(result.kind === 'unsupported' ? 'unsupported' : result.kind === 'outcome_unknown' ? 'unknown' : 'idle');
      if (result.kind === 'observed' || result.kind === 'accepted') void onRestarted();
    }, (error: unknown) => {
      const outcome = readDeploymentActionError(error);
      if (outcome.kind === 'approval') {
        review.request(outcome.artifactId);
        setRestartState('approval');
      } else {
        setRestartState('failed', outcome.kind === 'refused' ? outcome.code : null);
      }
    });
  } : null;
  // The row's admitted exec capability decides, the same fact the Machine service page reads.
  const runCommand = row?.capabilities.exec === true && generation && machineId ? () => showServiceCommandSheet({
    serverId: props.serverId, machineId, machineName: props.machineName, serviceName: service.name, place: props.place,
    target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: generation },
  }) : null;
  const openOnMachine = props.openOnMachine;
  const openLogs = props.onOpenLogs ? () => props.onOpenLogs?.(service.name) : null;
  const items = React.useMemo((): readonly DropdownMenuItem[] => {
    const icon = (name: 'arrow-clockwise' | 'terminal' | 'hard-drives' | 'list') =>
      <Icon name={name} size={16} color={theme.colors.text.secondary} />;
    return [
      ...(openLogs ? [{ id: 'logs', testID: `project-deployments.environment.services.${service.name}.logs`,
        title: t('projects.deployments.overviewStatus.logsTitle'), icon: icon('list') }] : []),
      ...(pressRestart ? [{ id: 'restart', testID: `project-deployments.environment.services.${service.name}.restart`,
        title: t('machineServices.control.restart'), icon: icon('arrow-clockwise') }] : []),
      ...(runCommand ? [{ id: 'command', testID: `project-deployments.environment.services.${service.name}.command`,
        title: t('machineServices.control.runCommand'), subtitle: t('machineServices.control.runCommandDetail'), icon: icon('terminal') }] : []),
      ...(openOnMachine ? [{ id: 'machine', testID: `project-deployments.environment.services.${service.name}.machine`,
        title: t('projects.deployments.overviewStatus.openOnMachine', { machine: props.machineName }),
        subtitle: t('projects.deployments.overviewStatus.openOnMachineDetail'), icon: icon('hard-drives') }] : []),
    ];
    // The menu's rows follow which operations exist, not the callbacks' identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(openLogs), Boolean(pressRestart), Boolean(runCommand), Boolean(openOnMachine), props.machineName, service.name, theme.colors.text.secondary]);
  return items.length > 0 ? (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => {
        if (id === 'logs') openLogs?.();
        else if (id === 'restart') pressRestart?.();
        else if (id === 'command') runCommand?.();
        else if (id === 'machine') openOnMachine?.();
      }}
      trigger={({ toggle }) => (
        <IconButton
          testID={`project-deployments.environment.services.${service.name}.menu`}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        />
      )}
    />
  ) : null;
}

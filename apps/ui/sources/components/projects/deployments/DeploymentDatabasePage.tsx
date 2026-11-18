import { DeploymentAddReview, showDeploymentAppSourcesSheet } from './DeploymentAddReview';
import { ProjectSourceWorkspaceChoice, useProjectSourceWorkspaceChoice } from '@/components/projects/sources/ProjectSourceWorkspaceChoice';
import type { ProjectAccountWorkspaceRefKeyV1 } from '@happier-dev/protocol/projects/workspaceRefKeyV1';
import { randomUUID } from '@/platform/randomUUID';
import type { DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
export { DeploymentAddRefusal, showDeploymentAppSourcesSheet } from './DeploymentAddReview';
import * as React from 'react';
import { View } from 'react-native';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import type {
  DeploymentEnvironmentDestinationV1,
  DeploymentEnvironmentReadDetailV1,
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { DeploymentBackupControls, DeploymentBackupSectionActions, deploymentBackupAttention, useDeploymentBackupFacts,
  useDeploymentBackupOperations, useDeploymentRestoreDrill } from './DeploymentBackupControls';
import { databaseEngineTitle, describeDatabaseSize } from './databasePresentation';
import {
  DeployOutcomeBanner,
  type DeploymentReviewHandle,
} from './DeploymentEnvironmentDetail';
import { useDeploymentTargetDeclarations, useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { StoreRegistryItemPicker } from '@/components/store/StoreKindPage';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { StoreMachineScopeContext } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { DeploymentEnvironmentChooser } from './DeploymentEnvironmentCollection';
import { showDeploymentDatabaseMoveSheet } from './DeploymentDatabaseMoveSheet';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { isPrivateServiceExport, privateServiceExportAuthoring } from './privateServiceExport';
import { privateServiceExportReachLabel, privateServiceExportUnavailableReason } from './DeploymentPrivateServiceExports';
import { type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { DeploymentManagedDataSheet, type DeploymentManagedDataInput } from './DeploymentManagedData';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { createDeploymentActions } from './deploymentActions';
import {
  deploymentBackupCaptureChoices,
  deploymentRestoreOperands,
  retainedBackupFromSummary,
} from './deploymentRestore';
import { deploymentDataTargetOperands, selectDeploymentTargetRemovalChoicesV1 } from '@happier-dev/deployments';
import { useDeploymentEnvironmentDeletion } from './useDeploymentEnvironmentDeletion';
import { showDeploymentDispositionSheet } from './DeploymentDispositionSheet';
import { managedDataTargets } from './managedData';
import { readPlatformResourceName } from './platformTargetLink';
import {
  showDeploymentRestoreSheet,
  type DeploymentRestoreChoice,
  type DeploymentRestoreSheetInput,
} from './DeploymentRestoreSheet';
import {
  useDeploymentDataServicePage,
  useDeploymentEnvironmentRecord,
  useEnvironmentBackupSummary,
} from './useDeploymentReads';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { useDeploymentTargetLinkChoices } from './useDeploymentTargetLinkChoices';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, DatabaseTargetsListResultV1Schema }
  from '@happier-dev/database-protocol';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { HappyError } from '@/utils/errors/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

type Detail = DeploymentEnvironmentReadDetailV1;
type TemplateData = NonNullable<
  NonNullable<Detail['content']['template']>['data']
>[number];
type DataLink = Detail['targetLinks'][number];

/** The database a page address names: the template's data service, or one linked data target. */
type Database =
  | Readonly<{ kind: 'selfHosted'; key: string; data: TemplateData }>
  | Readonly<{ kind: 'managed'; key: string; link: DataLink }>;

function resolveDatabase(detail: Detail, key: string): Database | null {
  const data = detail.content.template?.data?.find(entry => entry.service === key);
  if (data) return { kind: 'selfHosted', key, data };
  const link = detail.targetLinks.find(
    (entry) => entry.targetLink.role === 'data' && entry.targetLink.id === key,
  );
  return link ? { kind: 'managed', key, link } : null;
}

const noop = () => {};

/**
 * P9: one database of an Environment, pushed in place like a receipt. Identity, how apps reach it, its backups,
 * and (for a managed database) who runs it. Every control is an existing Action through the page's facades.
 */
export function DeploymentDatabasePage(
  props: Readonly<{
    controller: DeploymentReadControllerV1 | null;
    environmentId: string;
    /** The template data service, or the linked data target's id. */
    database: string;
    demand: DeploymentReadDemandV1;
    phone: boolean;
    lifetime: ServerAccountScopeLifetime | null;
    review: DeploymentReviewHandle;
    restore: DeploymentRestoreSheetInput['restore'] | null;
    /** Adds the reference binding on the chosen app's Environment (Connect to an app). */
    setBindings: DeploymentSetBindings | null;
    onBack: () => void;
    onNavigate: (destination: DeploymentEnvironmentDestinationV1) => void;
  }>,
) {
  const record = useDeploymentEnvironmentRecord(
    props.controller,
    props.environmentId,
    props.demand,
  );
  const detail = record.snapshot.value;
  const activeId = detail?.runtimeTargetLink?.activeDeploymentId ?? null;
  // The size DB-SIZE-1113's read reports for this database, for the facts row; read with the page.
  const sizes = useDeploymentDataServicePage(props.controller, props.demand, { environmentId: props.environmentId });
  const retained = useEnvironmentBackupSummary(
    props.controller,
    props.environmentId,
    activeId,
    props.demand,
  );
  const selection = React.useMemo(() => detail ? resolveDatabase(detail, props.database) : null, [detail, props.database]);
  const presented = props.demand.mounted && props.demand.visible && props.demand.focused;
  const targets = React.useMemo(() => selection?.kind === 'managed' ? [selection.link] : [], [selection]);
  const { choices, retry: retryTargetLink } = useDeploymentTargetLinkChoices({ lifetime: props.lifetime,
    environmentId: props.environmentId, targets, presented });
  const openedLink = choices.rows.find(row => row.targetLink.id === props.database);
  const database = selection?.kind === 'managed'
    ? openedLink ? { ...selection, link: openedLink } : null : selection;
  const backupConfiguration =
    detail?.content.backup && 'configRevision' in detail.content.backup
      ? detail.content.backup
      : null;
  // The Environment's configured backup stream also runs here: its triggers read under Also runs here (Plan 05).
  const backupEnvironmentId = backupConfiguration ? detail?.environment.id ?? null : null;
  const backupServerId = detail?.environment.serverId ?? null;
  const backupContext = React.useMemo(() => backupEnvironmentId && backupServerId
    ? [{ kind: 'backup' as const, serverId: backupServerId, environmentId: backupEnvironmentId }] : undefined,
  [backupEnvironmentId, backupServerId]);
  const lifetime = props.lifetime;
  const projectSourceId = detail?.environment.projectSourceId ?? null;
  const actions = React.useMemo(
    () =>
      lifetime && projectSourceId
        ? createDeploymentActions(lifetime, projectSourceId)
        : null,
    [lifetime, projectSourceId],
  );
  const target =
    detail && database?.kind === 'selfHosted'
      ? deploymentDataTargetOperands(detail)
      : null;
  const factsInput =
    target && activeId && backupConfiguration
      ? {
          ...target,
          deploymentId: activeId,
          configRevision: backupConfiguration.configRevision,
        }
      : null;
  // The kept restore points the destination reports for this database's own dump sources (the facts row's count).
  const restorePointSourceIds = database?.kind === 'selfHosted' && backupConfiguration
    ? backupConfiguration.sources.filter((source) => source.kind === 'dump' && source.service === database.data.service)
      .map((source) => source.sourceId)
    : null;
  const backup = useDeploymentBackupFacts(actions, factsInput, presented, restorePointSourceIds);
  // One controller for Back up now (section title and missed notice), a backup's checks and Remove old backups now.
  const backupOperations = useDeploymentBackupOperations({ detail: database?.kind === 'selfHosted' ? detail ?? null : null,
    configuration: database?.kind === 'selfHosted' ? backupConfiguration ?? null : null, actions,
    review: props.review, onSettled: backup.reload });
  const restoreDrill = useDeploymentRestoreDrill(lifetime && detail ? detail.environment.serverId : null);
  // Opening the console reads its targets through the Action owner; a refusal reads as words in the console section.
  const consoleOpen = useDeploymentChangePress(props.review, noop);
  const machineIds = React.useMemo(
    () => (target ? [target.machineId] : []),
    [target?.machineId],
  );
  const machineNames = useMachineDisplayNamesById(machineIds);
  const machineName = (machineId: string) =>
    machineNames[machineId] ?? t('projects.deployments.aMachine');
  const platformTitle = useDeploymentPlatformTargetTitles(
    lifetime,
    database?.kind === 'managed',
  );
  const targetDeclarations = useDeploymentTargetDeclarations(database?.kind === 'managed' ? lifetime : null);
  // Unlink or delete a managed project through the same removal review and action owner as a runtime target.
  const disposition = useDeploymentEnvironmentDeletion({ environmentId: props.environmentId, lifetime,
    snapshot: record.snapshot, actions, controller: props.controller, demand: props.demand });
  const catalog = useSavedSecretCatalogEntries({
    scope: lifetime?.scope ?? null,
  });
  const backControl = usePageBackControl(
    'project-deployments.database.back',
    props.onBack,
  );
  const workbenchNavigation = usePluginSurfaceDestinationNavigationBinding();
  const openWorkbench = () => consoleOpen.press(async () => {
    if (!actions || !detail || !database || !workbenchNavigation) return { ok: true };
    if (!detail.environment.controllerMachineId) throw new HappyError('machine_unavailable', false);
    const scope = { kind: 'environment' as const, environment: {
      serverId: detail.environment.serverId, projectSourceId: detail.environment.projectSourceId,
      environmentId: detail.environment.id,
    } };
    const result = await actions.inspectPlatformTarget(DATABASE_TARGETS_LIST_ACTION_ID_V1, { scope }, {
      externalActionTarget: { kind: 'machine', machineId: detail.environment.controllerMachineId },
    });
    if (!result.ok) throw new HappyError(result.code, false);
    const listed = DatabaseTargetsListResultV1Schema.parse(result.value);
    const matches = listed.targets.filter(({ target }) => database.kind === 'selfHosted'
      ? target.kind === 'deployment_service' && target.serviceId === database.data.service
      : target.kind === 'managed_deployment' && target.targetLinkId === database.link.targetLink.id);
    const opened = await workbenchNavigation.openSurface({
      destination: { pluginId: DATABASE_PLUGIN_ID_V1, localId: 'database-workbench' }, subPath: 'console',
      input: projectNativeJsonValueForTransport({ scope, ...(matches.length === 1 ? { descriptor: matches[0] } : {}) }),
    });
    if (!opened.ok) throw new HappyError(opened.reason, false);
    return { ok: true };
  });
  const id = 'project-deployments.database';
  const { theme } = useUnistyles();

  if (!detail) {
    return (
      <ItemList testID={`${id}.state`}>
        {record.snapshot.status === 'unavailable' ? (
          <SurfaceStateCard
            kind="error"
            title={t('projects.deployments.environmentErrorTitle')}
            diagnosticCode={record.snapshot.failure?.code ?? null}
            action={{
              label: t('common.retry'),
              onPress: () => {
                void record.refresh();
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
  if (!selection) {
    return (
      <NavigationBackChromeProvider control={backControl}>
        <ItemList testID={`${id}.gone`}>
          <SurfaceStateCard
            kind="empty"
            title={t('projects.deployments.databaseGoneTitle')}
            action={{
              label: t('projects.deployments.databaseBackToOverview'),
              onPress: props.onBack,
            }}
          />
        </ItemList>
      </NavigationBackChromeProvider>
    );
  }

  if (!database) {
    return <NavigationBackChromeProvider control={backControl}>
      <ItemList testID={`${id}.state`}>
        <PageHeader title={selection.kind === 'managed' ? selection.link.targetLink.targetKind : databaseEngineTitle(selection.data)} />
        {choices.kind === 'failed' ? <SurfaceStateCard testID={`${id}.failed`} kind="error"
          title={t('projects.deployments.environmentErrorTitle')} diagnosticCode={choices.code}
          action={{ label: t('common.retry'), onPress: retryTargetLink }} />
          : <SurfaceStateCard testID={`${id}.loading`} kind="loading" title={t('projects.deployments.loading')} />}
      </ItemList>
    </NavigationBackChromeProvider>;
  }

  const facts = backup.facts;
  const ready = facts?.status === 'ready' ? facts : null;
  const { missed, failed: failedBackup } = deploymentBackupAttention(facts);
  const failed = failedBackup !== null;
  const status = missed
    ? {
        variant: 'warning' as const,
        label: t('projects.deployments.databaseStatusMissed'),
      }
    : failed
      ? {
          variant: 'danger' as const,
          label: t('projects.deployments.databaseStatusFailed'),
        }
      : null;

  const providerConsole = database.kind === 'managed' ? database.link.content.data?.providerConsole : undefined;
  const title =
    database.kind === 'selfHosted'
      ? databaseEngineTitle(database.data)
      : database.link.content.data ? databaseEngineTitle(database.link.content.data)
      : ((database.link.targetLink.source?.kind === 'plugin'
          ? platformTitle(database.link.targetLink.source)
          : null) ?? database.link.targetLink.targetKind);
  const meta: PageHeaderMetaFact[] =
    database.kind === 'selfHosted'
      ? [
          {
            key: 'where',
            text: target
              ? t('projects.deployments.databaseWhere', {
                  service: database.data.service,
                  machine: machineName(target.machineId),
                })
              : database.data.service,
          },
        ]
      : [{ key: 'where', text: database.link.targetLink.source.kind === 'plugin'
          ? platformTitle(database.link.targetLink.source) ?? database.link.targetLink.targetKind
          : database.link.targetLink.targetKind }];


  const runBackup = backupOperations.run;

  const retainedBackup =
    retained.result.value && activeId
      ? retainedBackupFromSummary(retained.result.value, null)
      : null;
  const restoreOperands = retainedBackup
    ? deploymentRestoreOperands(detail, retainedBackup)
    : null;
  const restoreAction = props.restore;
  const retainedChoice: DeploymentRestoreChoice | null = retainedBackup && restoreOperands ? {
    snapshotId: retainedBackup.restoreBackupId, takenAtMs: retainedBackup.takenAtMs, kind: 'beforeMigration',
    restore: { backup: retainedBackup, operands: restoreOperands },
  } : null;
  // The restore points are the destination's inventory, read when the sheet opens. A deploy's pre-migration capture
  // restores through its receipt; any other retained run's snapshot names its run (`backupOperationId`, T2-DATA 16:06).
  const loadChoices = actions && factsInput && target && activeId && database.kind === 'selfHosted' ? async (): Promise<readonly DeploymentRestoreChoice[]> => {
    try {
      const inventory = await actions.backupInventory(factsInput);
      const dump = backupConfiguration?.sources.find((source) => source.kind === 'dump' && source.service === database.data.service);
      return deploymentBackupCaptureChoices({ inventory, target, deploymentId: activeId,
        sourceId: dump?.sourceId ?? null,
        service: database.data.service, database: retainedBackup?.service === database.data.service ? retainedBackup.database : '', retainedChoice });
    } catch (error) {
      // The kept capture is still restorable through its own receipt when the inventory can't be read.
      if (retainedChoice) return [retainedChoice];
      throw error;
    }
  } : null;
  const uploadTarget: DeploymentRestoreSheetInput['uploadTarget'] = lifetime && target && activeId && database.kind === 'selfHosted'
    ? { scope: lifetime.scope, operands: { ...target, deploymentId: activeId }, destinations: [{ kind: 'database', service: database.data.service,
      ...(retainedBackup?.service === database.data.service ? { database: retainedBackup.database } : {}) },
      // This database's backed-up named volumes restore here too (owner 2026-11-17: Settings no longer offers restore).
      ...(backupConfiguration?.sources ?? []).flatMap(source => source.kind === 'volume' && source.service === database.data.service
        ? [{ kind: 'volume' as const, service: source.service, volume: source.volume }] : [])] } : undefined;
  const restoreMachineId = restoreOperands?.machineId ?? target?.machineId ?? null;
  const openRestore = restoreAction && loadChoices && restoreMachineId ? () => showDeploymentRestoreSheet({
    name: detail.content.name,
    machine: machineName(restoreMachineId),
    loadChoices,
    ...(uploadTarget ? { uploadTarget } : {}),
    restore: restoreAction,
    onApproval: props.review.request,
  }) : null;

  const lastGood = ready?.history?.lastSuccessfulBackup ?? null;
  // The data-service read resolves this database's Automation subject once; a binding without one (managed) has no section.
  const automationSubject = sizes.snapshot.value?.items.find((item) => item.environment.id === detail.environment.id)
    ?.databaseSubjects?.[props.database];
  // The facts row under the header (pfc-redesign dDb), led by Last backup; each fact only as its owner reports it.
  const measured = database.kind === 'selfHosted'
    ? sizes.snapshot.value?.items.find((item) => item.environment.id === detail.environment.id)
      ?.databaseSizes?.find((entry) => entry.service === database.data.service) ?? null
    : null;
  // A readback that checked this very backup is said beside it (lab dDb "verified"); an older check is not.
  const verification = ready?.history?.lastVerification;
  const lastVerified = !!lastGood && verification?.backupOperationId === lastGood.operationId && verification.result === 'verified';
  const headerFacts: FactStripFact[] = database.kind === 'selfHosted' ? [
    { key: 'lastBackup', label: t('projects.deployments.databaseLastBackup'),
      value: facts?.status === 'loading' ? t('common.loading')
        : lastGood ? formatAsOfTime(lastGood.completedAt) : t('projects.deployments.databaseNoBackupYet'),
      ...(lastVerified ? { detail: t('projects.deployments.databaseBackupVerified') } : {}),
      ...(missed || (!lastGood && facts?.status !== 'loading') ? { tone: 'attention' as const } : {}) },
    ...(ready?.restorePoints ? [{ key: 'restorePoints', label: t('projects.deployments.databaseRestorePoints'),
      value: ready.restorePoints.status === 'ready' ? String(ready.restorePoints.count) : '—' }] : []),
    // A self-hosted database is one service on one server (lab database/selfhosted, J5); said once, here.
    { key: 'availability', label: t('projects.deployments.databaseAvailability'),
      value: t('projects.deployments.databaseAvailabilityOneServer'),
      detail: t('projects.deployments.databaseAvailabilityNotHighlyAvailable') },
    { key: 'size', label: t('projects.deployments.services.sizeLabel'),
      value: measured ? describeDatabaseSize(measured.size, 'labelled') : '—' },
  ] : [];
  // The variables that carry this database to its Environment's apps, by the names its template declares.
  const databaseVariableNames = database.kind === 'selfHosted'
    ? Object.values(database.data.variables ?? {}).filter((name): name is string => !!name)
    : [];
  // Connect to an app: another Environment reads this database through one of its shared exports.
  const controller = props.controller;
  const connectExports = database.kind === 'selfHosted'
    ? (detail.content.ownServer?.serviceExports ?? []).filter((entry) => entry.service === database.data.service
      && (isPrivateServiceExport(entry) || entry.exposure === 'public'))
    : [];
  const setBindings = props.setBindings;
  // Sharing is authored in Settings › Private sharing; its owner decides whether this viewer can do it here.
  const sharing = privateServiceExportAuthoring(detail, detail.environment.capabilities.role === 'manager');
  const openSharing = sharing.kind === 'ready'
    ? () => props.onNavigate({ tab: 'settings', section: 'sharing' }) : null;
  const sharingBlocked = sharing.kind === 'unavailable' ? privateServiceExportUnavailableReason(sharing.reason) : null;
  const openConnect = database.kind === 'selfHosted' && setBindings && controller ? () => showDeploymentSheet({
    component: DeploymentConnectSheet,
    props: { controller, sourceEnvironmentId: detail.environment.id, exports: connectExports,
      setBindings, review: props.review,
      ...(openSharing ? { onOpenSettings: openSharing } : {}),
      ...(sharingBlocked ? { sharingBlocked } : {}) },
    title: t('projects.deployments.databaseConnectTitle'),
    testID: 'project-deployments.connect.modal',
  }) : null;
  const openMove = database.kind === 'selfHosted' && database.data.engine === 'postgres' && controller && actions && factsInput && lifetime
    && detail.environment.capabilities.manage ? () => showDeploymentDatabaseMoveSheet({
      controller, source: detail, data: database.data, actions, backupTarget: factsInput,
      review: props.review, lifetime,
    }) : null;
  const openManaged = database.kind === 'managed' && lifetime && actions && detail.environment.capabilities.manage
    ? () => showManagedDataSheet({ detail, lifetime, actions, linked: database.link,
      onApproval: props.review.request }) : null;
  const managedTarget = database.kind === 'managed' && database.link.targetLink.source.kind === 'plugin'
    && targetDeclarations.state.status === 'ready' ? (() => {
      const source = database.link.targetLink.source.contribution;
      return managedDataTargets(targetDeclarations.state.declarations)
        .find(target => target.pluginId === source.pluginId && target.targetId === source.localId) ?? null;
    })() : null;
  // The removal owner decides which choices exist and where the review starts (created: Delete; linked: Unlink).
  const openRemoval = database.kind === 'managed' && managedTarget && disposition.canDelete ? () => {
    const link = database.link;
    const removal = selectDeploymentTargetRemovalChoicesV1(link.targetLink.source, [managedTarget],
      link.content.providerResourceOrigin);
    showDeploymentDispositionSheet({
      subject: { kind: 'target', targetLinkId: link.targetLink.id },
      name: detail.content.name, machine: null, provider: managedTarget.title, running: false,
      hasRetainedAssociations: true, canRemove: removal.choices.includes('delete'),
      providerResource: { name: readPlatformResourceName(link.content) ?? managedTarget.title,
        consequence: managedTarget.teardownConsequence ?? null, defaultChoice: removal.defaultChoice, role: 'data' },
      // A project's removal is one teardown of its data link; the Environment stays.
      run: choice => disposition.stopAndRemove(link.targetLink.id, undefined, undefined,
        { providerRemoval: choice === 'remove' ? 'delete' : 'unlink', removeEnvironment: false }),
      onApproval: props.review.request,
      onDone: () => {},
    });
  } : null;

  // The rare backup operations sit in the section's ⋯: where they go and how many are kept is configured in Settings.
  const backupMore = [
    ...(backupOperations.prune ? [{ id: 'prune', title: t('projects.deployments.settingsSections.pruneTitle'),
      onPress: () => { void backupOperations.prune?.(); } }] : []),
    ...(restoreDrill ? [{ id: 'drill', title: restoreDrill.title, onPress: restoreDrill.open }] : []),
    { id: 'settings', title: t('projects.deployments.backupDestination'),
      onPress: () => props.onNavigate({ tab: 'settings', section: 'backups' }) },
  ];

  return (
    <NavigationBackChromeProvider control={backControl}>
      <View style={styles.page}>
        <ItemList testID={id}>
          <PageHeader
            testID={`${id}.header`}
            title={title}
            alwaysShowTitle
            leading={<PageHeaderMarkIcon name="stack" />}
            titleAccessory={
              status ? (
                <StatusWord
                  testID={`${id}.status`}
                  variant={status.variant}
                  label={status.label}
                />
              ) : undefined
            }
            meta={meta}
            actionsPlacement="page"
            // Connect leads the page only once another Environment can use it; until it is shared, Private network says how.
            {...(openConnect && connectExports.length > 0 ? { primaryAction: { title: t('projects.deployments.databaseConnectTitle'),
              testID: `${id}.connect`, onPress: openConnect } } : {})}
            {...(openConnect && connectExports.length === 0 ? { actions: <SectionActionButton testID={`${id}.connect`}
              title={t('projects.deployments.databaseConnectTitle')} onPress={openConnect} /> } : {})}
          />
          {headerFacts.length > 0 ? (
            // The headline facts as one ruled sheet of cells (lab dDb), two to a row on a phone.
            <ItemGroup testID={`${id}.facts`}>
              <FactStrip facts={headerFacts} layout="columns" divided narrow={props.phone} testID={`${id}.facts.strip`} />
            </ItemGroup>
          ) : null}
          {missed ? (
            <AttentionBanner
              testID={`${id}.missed`}
              tone="warning"
              title={t('projects.deployments.databaseMissedTitle')}
              description={t('projects.deployments.databaseMissedBody', {
                time: formatAsOfTime(missed.dueAt),
              })}
              action={
                runBackup
                  ? {
                      label: t('projects.deployments.backupRun'),
                      loading: backupOperations.change.running,
                      disabled: backupOperations.change.running,
                      onPress: () => {
                        void runBackup();
                      },
                    }
                  : null
              }
            />
          ) : null}

          {database.kind === 'selfHosted' ? (
            <ConnectionSection
              testID={`${id}.connection`}
              detail={detail}
              data={database.data}
              catalog={catalog}
              scope={lifetime?.scope ?? null}
              {...(openSharing ? { onShare: openSharing } : {})}
              {...(sharingBlocked ? { sharingBlocked } : {})}
            />
          ) : null}

          {database.kind === 'selfHosted' || (actions && workbenchNavigation) ? (
            // One console row: it opens where this Home can open one, and otherwise says why it can't (a console
            // opens only over a private route, never publicly; no private Domain provider serves one yet).
            <ItemGroup testID={`${id}.console`} title={t('projects.deployments.overviewStatus.consoleTitle')}>
              {actions && workbenchNavigation ? (
                <Item testID={`${id}.query`} title={t('common.open')}
                  icon={<Icon name="terminal" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                  loading={consoleOpen.running} onPress={() => { void openWorkbench(); }} />
              ) : (
                <Item
                  testID={`${id}.console.access`}
                  title={t('projects.deployments.overviewStatus.consolePrivateAccess')}
                  mode="info"
                  detail={t('projects.deployments.overviewStatus.consolePrivateUnavailable')}
                />
              )}
              {consoleOpen.outcome ? <DeployOutcomeBanner controller={consoleOpen.banner}
                machine={target ? machineName(target.machineId) : null} copy="setting" /> : null}
            </ItemGroup>
          ) : null}

          {database.kind === 'selfHosted' && !backupConfiguration ? (
            // Nothing copies this database yet: say what that means and lead to the one place that sets it up.
            <ItemGroup
              testID={`${id}.backups`}
              title={t('projects.deployments.dataBackups')}
              description={t('projects.deployments.databaseBackupsUnprotected')}
            >
              {/* Last backup is said once, in the facts row under the header (lab dDb). */}
              {detail.environment.capabilities.manage ? (
                <Item
                  testID={`${id}.backups.setUp`}
                  title={t('projects.deployments.settingsSections.setupTitle')}
                  icon={<Icon name="gear" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                  onPress={() => props.onNavigate({ tab: 'settings', section: 'backups' })}
                />
              ) : null}
            </ItemGroup>
          ) : null}

          {database.kind === 'selfHosted' && backupConfiguration ? (
            <ItemGroup
              testID={`${id}.backups`}
              title={t('projects.deployments.dataBackups')}
              description={t('projects.deployments.databaseBackupsDescription')}
              action={
                <DeploymentBackupSectionActions
                  operations={backupOperations}
                  onRestore={openRestore}
                  more={backupMore}
                  testID={id}
                />
              }
            >
              <DeploymentBackupControls operations={backupOperations} facts={facts}
                machineName={machineName} testID={id} />
            </ItemGroup>
          ) : null}

          {automationSubject?.ok ? (
            <SubjectTriggersSection subject={automationSubject.subject} subjectName={title}
              accountLifetime={lifetime} contextSubjects={backupContext} />
          ) : null}

          <ItemGroup
            testID={`${id}.usedBy`}
            title={t('projects.deployments.tabVariables')}
            description={t('projects.deployments.databaseUsedByDescription')}
            {...(openMove ? { action: <SectionActionButton testID={`${id}.move`}
              title={t('projects.deployments.databaseMoveTitle')} onPress={openMove} /> } : {})}
          >
            <Item
              testID={`${id}.variables`}
              title={t('projects.deployments.dataVariables')}
              icon={<Icon name="list" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
              {...(databaseVariableNames.length > 0 ? { subtitle: databaseVariableNames.join(', ') } : {})}
              onPress={() =>
                props.onNavigate({ tab: 'variables', section: null })
              }
            />
          </ItemGroup>

          {database.kind === 'managed' ? (
            <ItemGroup
              testID={`${id}.provider`}
              title={t('projects.deployments.databaseProviderTitle')}
            >
              {providerConsole ? <Item testID={`${id}.providerConsole`}
                title={providerConsole.label}
                onPress={() => props.controller && requestOpenExternalUrl(providerConsole.url, { serverId: props.controller.scope.serverId, expectedAccountId: props.controller.scope.accountId })} /> : null}
              {openManaged ? <Item testID={`${id}.manage`} title={t('projects.deployments.managedData.manage')}
                onPress={openManaged} /> : null}
              <Item
                title={database.link.targetLink.source.kind === 'plugin'
                  ? platformTitle(database.link.targetLink.source) ?? database.link.targetLink.targetKind
                  : database.link.targetLink.targetKind}
                subtitle={database.link.content.providerIdentity?.providerResourceId}
                mode="info"
              />
              {/* Removal comes last in the provider section: Unlink is the safe choice, deletion is typed. */}
              {openRemoval ? <Item testID={`${id}.remove`} title={t('projects.deployments.platformLink.removalTitle',
                { resource: readPlatformResourceName(database.link.content) ?? database.link.targetLink.targetKind })}
                onPress={openRemoval} /> : null}
            </ItemGroup>
          ) : null}
        </ItemList>
      </View>
    </NavigationBackChromeProvider>
  );
}

/**
 * How apps reach a self-hosted database: its internal address, then whether the Environment exports it on a
 * private network or publicly (the Environment's saved exports), then its saved login as Reveal/Copy rows.
 */
/** P10: Add a service or database to this Environment, in place over it. Never routes to Store. */
export type DeploymentAddSheetInput = Readonly<{
  detail: Detail;
  /** The catalog conditions this entry point opens with: Data → Add passes the database category. */
  catalogFilters: SettingsCollectionFilter;
  /** Opens the editor a refusal's recovery names (Domains for a required address). */
  onOpenRecovery?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
  onNavigate?: (destination: DeploymentEnvironmentDestinationV1) => void;
  lifetime: ServerAccountScopeLifetime;
  review: DeploymentReviewHandle;
  machineName: (machineId: string) => string;
}>;

export function showDeploymentAddSheet(input: DeploymentAddSheetInput): void {
  showDeploymentSheet({
    component: DeploymentAddSheet,
    props: input,
    title: t('projects.deployments.addTitle'),
    testID: 'project-deployments.add.modal',
  });
}

/** Updating reuses Add's pinned registry read and the same template Action, without another instance or deploy. */
export function showDeploymentTemplateUpdateSheet(input: DeploymentAddSheetInput & Readonly<{
  template: Readonly<{ sourceId: string; itemId: string }>;
}>): void {
  showDeploymentSheet({ component: DeploymentAddSheet, props: { ...input, update: input.template },
    title: t('projects.deployments.overviewStatus.catalogUpdateReview'), testID: 'project-deployments.template.update' });
}

/** Choose (Store's own catalog list, its row press routed here) → review with preflight → Add. */
type AddSheetProps = DeploymentAddSheetInput & CustomModalInjectedProps & Readonly<{
  update?: Readonly<{ sourceId: string; itemId: string }>;
  /** The managed-database way in: one more choice on the chooser step, gone once an app is chosen. */
  managedEntry?: React.ReactNode;
}>;
function showManagedDataSheet(input: DeploymentManagedDataInput): void {
  showDeploymentSheet({ component: DeploymentManagedDataSheet, props: input,
    title: t('projects.deployments.managedData.title'), testID: 'project-deployments.managed.modal' });
}

function DeploymentAddSheet(props: AddSheetProps) {
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime,
    props.detail.environment.projectSourceId), [props.lifetime, props.detail.environment.projectSourceId]);
  const managedEntry = props.update ? undefined : <ItemGroup header="none" surface="none">
    <Item testID="project-deployments.add.managed" icon={<Icon name="cloud" size={20} />}
      title={t('projects.deployments.managedData.add')} subtitle={t('projects.deployments.managedData.addDescription')}
      onPress={() => {
        props.onClose();
        showManagedDataSheet({ detail: props.detail, lifetime: props.lifetime, actions, onApproval: props.review.request });
      }} />
  </ItemGroup>;
  return props.detail.content.definition.kind === 'repository'
    ? <DeploymentRepositoryAddSheet {...props} managedEntry={managedEntry} /> : <DeploymentAddSheetContent {...props} managedEntry={managedEntry} />;
}

function DeploymentRepositoryAddSheet(props: AddSheetProps) {
  const [workspaceKey, setWorkspaceKey] = React.useState<ProjectAccountWorkspaceRefKeyV1 | null>(null);
  const [branchName] = React.useState(() => `happier-template-${randomUUID()}`);
  const selection = useProjectSourceWorkspaceChoice({ lifetime: props.lifetime,
    sourceId: props.detail.environment.projectSourceId, value: workspaceKey });
  const definition = props.detail.content.definition;
  if (definition.kind !== 'repository') return null;
  if (!selection.source || !selection.repository || !selection.workspace || !workspaceKey || !selection.baseCommit
    || !selection.baseBranch || !definition.compose?.path) return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.add.repository" style={deploymentSheetStyles.body}>
      {props.managedEntry}
      <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.overviewStatus.catalogRepositoryBody')}</Text>
      <ProjectSourceWorkspaceChoice model={selection} value={workspaceKey} onChange={setWorkspaceKey} testID="project-deployments.add.workspace" />
      {!definition.compose?.path ? <SurfaceStateCard size="line" kind="unavailable"
        title={t('projects.deployments.addRepositoryDefined')} /> : null}
    </View>
  </ListPresentationProvider>;
  return <DeploymentAddSheetContent {...props} repositoryDestination={{ kind: 'repositoryPullRequest', workspace: workspaceKey,
    sourceRevision: selection.source.revision, repository: selection.repository, baseCommit: selection.baseCommit,
    baseBranch: selection.baseBranch, branchName, composePath: definition.compose.path,
    title: props.update ? t('projects.deployments.overviewStatus.catalogUpdateReview') : t('projects.deployments.addTitle') }} />;
}

function DeploymentAddSheetContent(props: AddSheetProps & Readonly<{
  repositoryDestination?: Extract<DeploymentTemplateInstantiateInputV1['destination'], { kind: 'repositoryPullRequest' }>;
}>) {
  const [chosen, setChosen] = React.useState<RegistryCatalogItemSummary | null>(() => props.update
    ? { kind: 'app', sourceId: props.update.sourceId, itemId: props.update.itemId, title: props.detail.content.name } : null);
  const select = React.useCallback((item: RegistryCatalogItemSummary) => setChosen(item), []);
  const { detail } = props;
  const machineScope = React.useMemo(() => ({ serverId: props.lifetime.scope.serverId,
    machineId: detail.environment.controllerMachineId }), [props.lifetime.scope.serverId, detail.environment.controllerMachineId]);
  const link = detail.runtimeTargetLink;
  const member = link?.targetKind === 'ownServer' ? link.members[0] : undefined;
  const definition = detail.content.definition;
  const blocked = !link || !member ? t('projects.deployments.addNeedsMachine') : null;
  const { setChrome, onClose } = props;
  const router = useRouter();
  const back = chosen ? () => setChosen(null) : null;
  if (blocked || !link || !member) {
    // An inline addition needs an own-server runtime. Store remains available for
    // creating a separate app when this Environment has no selected runtime.
    const openStore = () => {
      onClose();
      // The Store app catalog picker: the same list Add embeds, not a text search.
      router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', filters: props.catalogFilters,
        machine: { serverId: props.lifetime.scope.serverId, machineId: detail.environment.controllerMachineId } }) as never);
    };
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.add" style={deploymentSheetStyles.body}>
          {props.managedEntry}
          <SurfaceStateCard testID="project-deployments.add.blocked" size="line" kind="unavailable" title={blocked ?? ''}
            action={{ label: t('projects.deployments.addOpenStore'), onPress: openStore, testID: 'project-deployments.add.openStore' }} />
        </View>
      </ListPresentationProvider>
    );
  }
  if (!chosen) {
    return (
      <View testID="project-deployments.add.choose" style={deploymentSheetStyles.body}>
        {props.managedEntry}
        <StoreRegistryItemPicker presented initialFilters={props.catalogFilters} onSelect={select}
          machine={machineScope}
          testID="project-deployments.add.picker" />
      </View>
    );
  }
  return (
    <StoreMachineScopeContext.Provider value={machineScope}>
    <DeploymentAddReview item={chosen} detail={detail} lifetime={props.lifetime} review={props.review}
      machine={props.machineName(member.machineId)} onBack={back!} onClose={onClose} setChrome={setChrome} update={Boolean(props.update)}
      onManageSource={() => showDeploymentAppSourcesSheet(chosen.sourceId)}
      {...(props.onOpenRecovery ? { onOpenRecovery: props.onOpenRecovery } : {})}
      {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
      operands={{ ...(props.update ? {} : { intent: 'add' }), machineId: member.machineId, projectSourceId: detail.environment.projectSourceId,
        environment: { kind: 'existing', environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: member.installationId },
        destination: definition.kind === 'stored' ? { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest }
          : props.repositoryDestination! }} />
    </StoreMachineScopeContext.Provider>
  );
}

type DeploymentSetBindings = ReturnType<typeof createDeploymentActions>['setBindings'];
type ConnectExport = NonNullable<NonNullable<Detail['content']['ownServer']>['serviceExports']>[number];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Connect to an app (P9): pick the app's Environment with the shared chooser, the address to give it and the
 * variable name; one `deployments.bindings.set` on that Environment adds a reference binding. Nothing deploys.
 */
function DeploymentConnectSheet(props: Readonly<{
  controller: DeploymentReadControllerV1;
  sourceEnvironmentId: string;
  exports: readonly ConnectExport[];
  setBindings: DeploymentSetBindings;
  review: DeploymentReviewHandle;
  onOpenSettings?: () => void;
  /** Why this Environment cannot share it from Settings, and what to do instead. */
  sharingBlocked?: string;
}> & CustomModalInjectedProps) {
  const [destination, setDestination] = React.useState<Readonly<{ id: string; revision: number; title: string }> | null>(null);
  const selectDestination = React.useCallback((row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    setDestination({ id: row.environment.id, revision: row.environment.revision, title: row.title });
  }, []);
  const [exportKey, setExportKey] = React.useState(props.exports[0]?.key ?? null);
  const [variable, setVariable] = React.useState('DATABASE_URL');
  const [done, setDone] = React.useState<string | null>(null);
  const { onClose, review } = props;
  const press = useDeploymentChangePress({ request: (artifactId) => { onClose(); review.request(artifactId); } },
    () => { if (destination) setDone(destination.title); });
  const valid = destination !== null && exportKey !== null && VARIABLE_NAME.test(variable);
  const busy = press.running;
  const connect = () => {
    if (!valid || !destination || !exportKey) return;
    void press.press(() => props.setBindings({ environmentId: destination.id, expectedRevision: destination.revision, remove: [],
        set: [{ purpose: 'variable', name: variable, phase: 'runtime',
          source: { kind: 'reference', environmentId: props.sourceEnvironmentId, export: exportKey, via: 'auto' } }] }));
  };
  const footer = done ? (
    <ModalCardFooterActions>
      <RoundButton testID="project-deployments.connect.done" size="normal" title={t('common.done')} onPress={onClose} />
    </ModalCardFooterActions>
  ) : (
    <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.connect.cancel', disabled: busy }}>
      {props.exports.length > 0 ? <RoundButton testID="project-deployments.connect.confirm" size="normal"
        title={t('projects.deployments.databaseConnectConfirm')} disabled={!valid || busy} loading={busy} onPress={connect} /> : null}
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.connect" style={deploymentSheetStyles.body}>
        {done ? (
          <SurfaceStateCard testID="project-deployments.connect.connected" size="details" layout="inline" kind="success"
            title={t('projects.deployments.databaseConnectDone', { variable, name: done })} />
        ) : props.exports.length === 0 ? (
          <SurfaceStateCard testID="project-deployments.connect.needsShare" size="line" kind="empty"
            title={t('projects.deployments.databaseConnectNeedsShare')}
            {...(props.sharingBlocked ? { reason: props.sharingBlocked } : {})}
            {...(props.onOpenSettings ? { action: {
              label: t('projects.deployments.databaseShare'), testID: 'project-deployments.connect.openSettings',
              onPress: () => { onClose(); props.onOpenSettings?.(); },
            } } : {})} />
        ) : (
          <>
            <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseConnectLead')}</Text>
            <DeploymentEnvironmentChooser controller={props.controller} testID="project-deployments.connect.destination"
              title={t('projects.deployments.databaseConnectDestination')}
              eligible={(row) => row.environment.id !== props.sourceEnvironmentId && row.environment.capabilities.manage}
              selectedId={destination?.id ?? null} disabled={busy}
              onSelect={selectDestination}
              loadFailedTitle={t('projects.deployments.promotion.loadFailed')}
              emptyTitle={t('projects.deployments.databaseConnectEmptyTitle')}
              emptyBody={t('projects.deployments.databaseConnectEmptyBody')} />
            {props.exports.length > 1 ? (
              <ItemGroup title={t('projects.deployments.databaseConnectExport')}>
                {props.exports.map((entry) => (
                  <Item key={entry.key} testID={`project-deployments.connect.export:${entry.key}`} accessibilityRole="radio"
                    title={entry.exposure === 'public' ? t('projects.deployments.databasePublic') : t('projects.deployments.databasePrivate')}
                    subtitle={`${entry.service}:${entry.containerPort}`} selected={exportKey === entry.key}
                    showChevron={false} disabled={busy} onPress={() => setExportKey(entry.key)} />
                ))}
              </ItemGroup>
            ) : null}
            <FieldItem label={t('projects.deployments.databaseConnectVariable')}>
              <FieldTextInput testID="project-deployments.connect.variable" value={variable} onChangeText={setVariable}
                autoCapitalize="none" accessibilityLabel={t('projects.deployments.databaseConnectVariable')} />
            </FieldItem>
            {press.outcome?.kind === 'refused' ? (
              <SurfaceStateCard testID="project-deployments.connect.refused" size="line" kind="error"
                title={t('projects.deployments.databaseConnectRefused')} diagnosticCode={press.outcome.code}
                reason={deploymentActionRefusalRemedy(press.outcome.code)} />
            ) : null}
          </>
        )}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

function ConnectionSection(
  props: Readonly<{
    testID: string;
    detail: Detail;
    data: TemplateData;
    catalog: ReturnType<typeof useSavedSecretCatalogEntries>;
    scope: ServerAccountScopeLifetime['scope'] | null;
    /** Opens Private sharing, where this Environment shares a service; absent where this viewer cannot manage it. */
    onShare?: () => void;
    /** Why this Environment cannot share it from Settings, and what to do instead. */
    sharingBlocked?: string | null;
  }>,
) {
  const { data, detail } = props;
  const exports = (detail.content.ownServer?.serviceExports ?? []).filter(
    (entry) => entry.service === data.service,
  );
  const shared = exports.find(isPrivateServiceExport);
  const published = exports.find((entry) => entry.exposure === 'public');
  const loginNames = new Set(
    [data.variables?.username, data.variables?.password].filter(
      (name): name is string => !!name,
    ),
  );
  const secrets = detail.content.bindings.flatMap((binding) =>
    binding.purpose === 'variable' &&
    loginNames.has(binding.name) &&
    binding.source.kind === 'secret'
      ? [{ name: binding.name, ref: binding.source.ref }]
      : [],
  );
  return (
    <ItemGroup
      testID={props.testID}
      title={t('projects.deployments.databaseConnectionTitle')}
      description={t('projects.deployments.databaseConnectionDescription')}
    >
      <Item
        testID={`${props.testID}.internal`}
        title={t('projects.deployments.databaseInternal')}
        mode="info"
        subtitle={t('projects.deployments.databaseInternalDetail')}
        detail={
          data.port === undefined
            ? data.service
            : `${data.service}:${data.port}`
        }
      />
      <Item
        testID={`${props.testID}.private`}
        title={t('projects.deployments.databasePrivate')}
        mode="info"
        subtitle={
          shared ? undefined : props.sharingBlocked ?? t('projects.deployments.databaseNotSharedDetail')
        }
        {...(!shared && props.onShare ? {
          rightElement: <SectionActionButton testID={`${props.testID}.private.share`}
            title={t('projects.deployments.databaseShare')} onPress={props.onShare} />,
        } : {
          detail: shared
            ? t('projects.deployments.databasePrivateShared', { network: privateServiceExportReachLabel(shared) })
            : t('projects.deployments.databaseNotShared'),
        })}
      />
      <Item
        testID={`${props.testID}.public`}
        title={t('projects.deployments.databasePublic')}
        mode="info"
        subtitle={
          published ? t('projects.deployments.databasePublished') : undefined
        }
        rightElement={
          published ? (
            <StatusWord
              variant="warning"
              label={`${published.service}:${published.containerPort}`}
            />
          ) : undefined
        }
        detail={
          published ? undefined : t('projects.deployments.databaseNotPublished')
        }
      />
      {props.scope
        ? secrets.map((secret) => {
            const entry = props.catalog.find(
              (candidate) => candidate.ref === secret.ref,
            );
            return entry ? (
              <SharedSavedSecretValueItem
                key={secret.name}
                testID={`${props.testID}.secret.${secret.name}`}
                title={secret.name === data.variables?.password ? t('projects.deployments.databasePassword') : t('projects.deployments.databaseUsername')}
                scope={props.scope!}
                entry={entry}
                active
              />
            ) : null;
          })
        : null}
    </ItemGroup>
  );
}

const styles = StyleSheet.create(() => ({
  page: { flex: 1, minHeight: 0 },
}));

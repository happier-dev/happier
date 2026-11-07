import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  DeploymentEnvironmentDestinationV1,
  DeploymentEnvironmentReadDetailV1,
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentBackupHistoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupHistoryV1';

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
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { DeploymentBackupControls } from './DeploymentBackupControls';
import { engineNames } from './DeploymentDataCard';
import {
  DeployOutcomeBanner,
  type DeploymentReviewHandle,
} from './DeploymentEnvironmentDetail';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { StoreKindPage, StoreRegistryItemSelectContext } from '@/components/store/StoreKindPage';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { randomUUID } from '@/platform/randomUUID';
import { DeploymentEnvironmentChooser } from './DeploymentEnvironmentCollection';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { readDeploymentActionError, useDeploymentChangePress } from './deploymentActionOutcome';
import { createDeploymentActions } from './deploymentActions';
import {
  deploymentDataTargetOperands,
  deploymentRestoreOperands,
  retainedBackupFromSummary,
} from './deploymentRestore';
import {
  showDeploymentRestoreSheet,
  type DeploymentRestoreChoice,
  type DeploymentRestoreSheetInput,
} from './DeploymentRestoreSheet';
import {
  useDeploymentEnvironmentRecord,
  useEnvironmentBackupSummary,
} from './useDeploymentReads';

type Detail = DeploymentEnvironmentReadDetailV1;
type TemplateData = NonNullable<
  NonNullable<Detail['content']['template']>['data']
>;
type DataLink = Detail['targetLinks'][number];
type Missed = Readonly<{
  triggerId: string;
  dueAt: number;
  lastRunAt: number | null;
}>;

/** The database a page address names: the template's data service, or one linked data target. */
type Database =
  | Readonly<{ kind: 'selfHosted'; key: string; data: TemplateData }>
  | Readonly<{ kind: 'managed'; key: string; link: DataLink }>;

function resolveDatabase(detail: Detail, key: string): Database | null {
  const data = detail.content.template?.data;
  if (data && data.service === key) return { kind: 'selfHosted', key, data };
  const link = detail.targetLinks.find(
    (entry) => entry.targetLink.role === 'data' && entry.targetLink.id === key,
  );
  return link ? { kind: 'managed', key, link } : null;
}

/** Facts the page reads once per opening; the Action owners derive them, the page only shows them. */
type BackupFacts =
  | Readonly<{ status: 'loading' }>
  | Readonly<{
      status: 'ready';
      history: DeploymentBackupHistoryResultV1 | null;
      missed: readonly Missed[];
    }>
  | Readonly<{ status: 'unavailable' }>;

const LOADING: BackupFacts = Object.freeze({ status: 'loading' });
const NO_MISSED: readonly Missed[] = Object.freeze([]);

/**
 * Backup history (`deployments.backups.history`) and missed schedules (`workflow.trigger.list` for this capture
 * target), read when the page is presented and again after its own Back up now. No timer, no poll.
 */
function useDatabaseBackupFacts(
  actions: ReturnType<typeof createDeploymentActions> | null,
  input:
    | Parameters<ReturnType<typeof createDeploymentActions>['backupHistory']>[0]
    | null,
  presented: boolean,
) {
  const [facts, setFacts] = React.useState<BackupFacts>(LOADING);
  const [generation, setGeneration] = React.useState(0);
  const key = input ? JSON.stringify(input) : null;
  React.useEffect(() => {
    if (!actions || !input || !presented) return;
    let live = true;
    const { expectedRevision: _expectedRevision, ...target } = input;
    void Promise.allSettled([
      actions.backupHistory(input),
      actions.missedBackupSchedules(target),
    ]).then(([history, missed]) => {
      if (!live) return;
      if (history.status === 'rejected' && missed.status === 'rejected') {
        setFacts({ status: 'unavailable' });
        return;
      }
      setFacts({
        status: 'ready',
        history: history.status === 'fulfilled' ? history.value : null,
        missed: missed.status === 'fulfilled' ? missed.value : NO_MISSED,
      });
    });
    return () => {
      live = false;
    };
    // The serialized operands are the read's identity; the parsed object is rebuilt on every render.
  }, [actions, key, presented, generation]);
  const reload = React.useCallback(
    () => setGeneration((value) => value + 1),
    [],
  );
  return { facts: input ? facts : null, reload };
}

const HISTORY_ACTION = {
  backup: 'projects.deployments.databaseHistoryBackup',
  verify: 'projects.deployments.databaseHistoryVerify',
  prune: 'projects.deployments.databaseHistoryPrune',
} as const;

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
    setBindings: ((input: Parameters<DeploymentSetBindings>[0]) => Promise<unknown>) | null;
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
  const retained = useEnvironmentBackupSummary(
    props.controller,
    props.environmentId,
    activeId,
    props.demand,
  );
  const database = detail ? resolveDatabase(detail, props.database) : null;
  const backupConfiguration =
    detail?.content.backup && 'configRevision' in detail.content.backup
      ? detail.content.backup
      : null;
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
  const presented =
    props.demand.mounted && props.demand.visible && props.demand.focused;
  const backup = useDatabaseBackupFacts(actions, factsInput, presented);
  const backupNow = useDeploymentChangePress(props.review, backup.reload);
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
  const catalog = useSavedSecretCatalogEntries({
    scope: lifetime?.scope ?? null,
  });
  const backControl = usePageBackControl(
    'project-deployments.database.back',
    props.onBack,
  );
  const id = 'project-deployments.database';

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
  if (!database) {
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

  const facts = backup.facts;
  const ready = facts?.status === 'ready' ? facts : null;
  const missed = ready?.missed[0] ?? null;
  const entries = ready?.history?.history.entries ?? [];
  const latestBackup =
    entries.find((entry) => entry.action === 'backup') ?? null;
  const failed = latestBackup?.state === 'failed';
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

  const title =
    database.kind === 'selfHosted'
      ? `${engineNames[database.data.engine]}${database.data.version ? ` ${database.data.version}` : ''}`
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
      : [{ key: 'where', text: database.link.targetLink.targetKind }];

  const runBackup =
    factsInput && actions
      ? () =>
          backupNow.press(async () => {
            await actions.runBackup(factsInput);
            return { ok: true };
          })
      : null;

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
    const dump = backupConfiguration?.sources.find((source) => source.kind === 'dump' && source.service === database.data.service);
    try {
      const inventory = await actions.backupInventory(factsInput);
      const listed = inventory.snapshots.map((entry): DeploymentRestoreChoice => {
        if (entry.snapshot.snapshotId === retainedChoice?.snapshotId) return retainedChoice;
        const takenAtMs = Date.parse(entry.snapshot.time);
        const run = entry.verification.kind === 'verified' ? entry.verification.backupOperationId : null;
        return { snapshotId: entry.snapshot.snapshotId, takenAtMs, kind: 'scheduled', restore: run ? {
          backup: { deploymentId: activeId, restoreBackupId: entry.snapshot.snapshotId, takenAtMs,
            service: database.data.service, database: dump?.sourceId ?? database.data.service, versionLabel: null },
          operands: { ...target, deploymentId: activeId, restoreBackupId: entry.snapshot.snapshotId, backupOperationId: run },
        } : null };
      });
      const all = retainedChoice && !listed.includes(retainedChoice) ? [retainedChoice, ...listed] : listed;
      return [...all].sort((left, right) => right.takenAtMs - left.takenAtMs);
    } catch (error) {
      // The kept capture is still restorable through its own receipt when the inventory can't be read.
      if (retainedChoice) return [retainedChoice];
      throw error;
    }
  } : null;
  const restoreMachineId = restoreOperands?.machineId ?? target?.machineId ?? null;
  const openRestore = restoreAction && loadChoices && restoreMachineId ? () => showDeploymentRestoreSheet({
    name: detail.content.name,
    machine: machineName(restoreMachineId),
    loadChoices,
    restore: restoreAction,
    onApproval: props.review.request,
  }) : null;

  const lastGood = ready?.history?.lastSuccessfulBackup ?? null;
  // Connect to an app: another Environment reads this database through one of its shared exports.
  const controller = props.controller;
  const connectExports = database.kind === 'selfHosted'
    ? (detail.content.ownServer?.serviceExports ?? []).filter((entry) => entry.service === database.data.service
      && (entry.exposure === 'privateNetwork' || entry.exposure === 'public'))
    : [];
  const setBindings = props.setBindings;
  const openConnect = database.kind === 'selfHosted' && setBindings && controller ? () => showDeploymentSheet({
    component: DeploymentConnectSheet,
    props: { controller, sourceEnvironmentId: detail.environment.id, exports: connectExports,
      setBindings, review: props.review },
    title: t('projects.deployments.databaseConnectTitle'),
    testID: 'project-deployments.connect.modal',
  }) : null;

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
            {...(openConnect ? { primaryAction: { title: t('projects.deployments.databaseConnectTitle'),
              testID: `${id}.connect`, onPress: openConnect } } : {})}
          />
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
                      loading: backupNow.running,
                      disabled: backupNow.running,
                      onPress: () => {
                        void runBackup();
                      },
                    }
                  : null
              }
            />
          ) : null}
          {backupNow.outcome && target ? (
            <DeployOutcomeBanner
              outcome={backupNow.outcome}
              pending={
                backupNow.outcome.kind === 'approval' &&
                props.review.pendingId === backupNow.outcome.artifactId
              }
              machine={machineName(target.machineId)}
              onOpenReview={props.review.open}
              copy="setting"
            />
          ) : null}

          {database.kind === 'selfHosted' ? (
            <ConnectionSection
              testID={`${id}.connection`}
              detail={detail}
              data={database.data}
              catalog={catalog}
              scope={lifetime?.scope ?? null}
            />
          ) : null}

          <ItemGroup
            testID={`${id}.usedBy`}
            title={t('projects.deployments.databaseUsedByTitle')}
            description={t('projects.deployments.databaseUsedByDescription')}
          >
            <Item
              testID={`${id}.variables`}
              title={t('projects.deployments.dataVariables')}
              icon="list"
              onPress={() =>
                props.onNavigate({ tab: 'variables', section: null })
              }
            />
          </ItemGroup>

          {database.kind === 'selfHosted' && backupConfiguration ? (
            <ItemGroup
              testID={`${id}.backups`}
              title={t('projects.deployments.dataBackups')}
              description={t('projects.deployments.databaseBackupsDescription')}
              action={
                openRestore ? (
                  <SectionActionButton
                    testID={`${id}.restore`}
                    title={t('projects.deployments.restoreAction')}
                    onPress={openRestore}
                  />
                ) : undefined
              }
            >
              <Item
                testID={`${id}.lastGood`}
                title={t('projects.deployments.databaseLastBackup')}
                mode="info"
                detail={
                  facts?.status === 'loading'
                    ? undefined
                    : lastGood
                      ? formatAsOfTime(lastGood.completedAt)
                      : t('projects.deployments.databaseNoBackupYet')
                }
              />
              <Item
                testID={`${id}.destination`}
                title={t('projects.deployments.backupDestination')}
                subtitle={t('projects.deployments.databaseDestinationDetail')}
                icon="gear"
                onPress={() =>
                  props.onNavigate({ tab: 'settings', section: 'backups' })
                }
              />
              {lifetime ? (
                <DeploymentBackupControls
                  detail={detail}
                  configuration={backupConfiguration}
                  lifetime={lifetime}
                  review={props.review}
                  machineName={machineName}
                  testID={`${id}.controls`}
                />
              ) : null}
            </ItemGroup>
          ) : null}

          {database.kind === 'selfHosted' && backupConfiguration ? (
            <ItemGroup
              testID={`${id}.history`}
              title={t('projects.deployments.databaseHistoryTitle')}
            >
              {facts?.status === 'unavailable' ||
              (ready && ready.history === null) ? (
                <Item
                  testID={`${id}.history.unavailable`}
                  title={t('projects.deployments.databaseHistoryUnavailable')}
                  mode="info"
                />
              ) : ready && entries.length === 0 ? (
                <Item
                  testID={`${id}.history.empty`}
                  title={t('projects.deployments.databaseHistoryEmpty')}
                  mode="info"
                />
              ) : (
                entries.map((entry) => {
                  const action = t(HISTORY_ACTION[entry.action]);
                  return (
                    <Item
                      key={entry.operationId}
                      testID={`${id}.history.${entry.operationId}`}
                      title={formatAsOfTime(entry.completedAt)}
                      subtitle={
                        entry.state === 'failed'
                          ? t('projects.deployments.databaseHistoryFailed', {
                              action,
                            })
                          : entry.state === 'cancelled'
                            ? t(
                                'projects.deployments.databaseHistoryCancelled',
                                { action },
                              )
                            : entry.snapshotIds.length > 0
                              ? `${action} · ${t('projects.deployments.databaseHistorySnapshots', { count: entry.snapshotIds.length })}`
                              : action
                      }
                      mode="info"
                    />
                  );
                })
              )}
            </ItemGroup>
          ) : null}

          {database.kind === 'managed' ? (
            <ItemGroup
              testID={`${id}.provider`}
              title={t('projects.deployments.databaseProviderTitle')}
            >
              <Item
                title={title}
                subtitle={database.link.targetLink.targetKind}
                mode="info"
              />
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

/** Choose (Store's own catalog list, its row press routed here) → review with preflight → Add. */
function DeploymentAddSheet(props: DeploymentAddSheetInput & CustomModalInjectedProps) {
  const [chosen, setChosen] = React.useState<RegistryCatalogItemSummary | null>(null);
  const select = React.useCallback((item: RegistryCatalogItemSummary) => setChosen(item), []);
  const { detail } = props;
  const link = detail.runtimeTargetLink;
  const member = link?.targetKind === 'ownServer' ? link.members[0] : undefined;
  const definition = detail.content.definition;
  const blocked = definition.kind !== 'stored' ? t('projects.deployments.addRepositoryDefined')
    : !link || !member ? t('projects.deployments.addNeedsMachine') : null;
  const { setChrome, onClose } = props;
  const router = useRouter();
  const back = chosen ? () => setChosen(null) : null;
  if (blocked || !link || !member || definition.kind !== 'stored') {
    // This Environment can't take a template in place: its services live in its repository's Compose file. The
    // other way forward is a full app of its own from Store, on the same Machine, connected through Variables.
    const openStore = () => {
      onClose();
      // The Store app catalog picker: the same list Add embeds, not a text search.
      router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', filters: { category: { include: ['database'], exclude: [] } },
        machine: { serverId: props.lifetime.scope.serverId, machineId: detail.environment.controllerMachineId } }) as never);
    };
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.add" style={deploymentSheetStyles.body}>
          <SurfaceStateCard testID="project-deployments.add.blocked" size="line" kind="unavailable" title={blocked ?? ''}
            action={{ label: t('projects.deployments.addOpenStore'), onPress: openStore, testID: 'project-deployments.add.openStore' }} />
        </View>
      </ListPresentationProvider>
    );
  }
  if (!chosen) {
    return (
      <View testID="project-deployments.add.choose" style={styles.choose}>
        <StoreRegistryItemSelectContext.Provider value={select}>
          <StoreKindPage kind="app" presented />
        </StoreRegistryItemSelectContext.Provider>
      </View>
    );
  }
  return (
    <DeploymentAddReview item={chosen} detail={detail} lifetime={props.lifetime} review={props.review}
      machine={props.machineName(member.machineId)} onBack={back!} onClose={onClose} setChrome={setChrome}
      operands={{ machineId: member.machineId, projectSourceId: detail.environment.projectSourceId,
        environment: { kind: 'existing', environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: member.installationId },
        destination: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
        bindings: [] }} />
  );
}

type AddOperands = Omit<Parameters<ReturnType<typeof createDeploymentActions>['instantiateTemplate']>[0], 'mode' | 'templateRef'>;
type Preflight =
  | Readonly<{ status: 'checking' }>
  | Readonly<{ status: 'ready'; shortOn: readonly ('memoryBytes' | 'freeDiskBytes')[]; firstRun: boolean }>
  | Readonly<{ status: 'failed'; code: string }>;

function DeploymentAddReview(props: Readonly<{
  item: RegistryCatalogItemSummary;
  detail: Detail;
  lifetime: ServerAccountScopeLifetime;
  review: DeploymentReviewHandle;
  machine: string;
  operands: AddOperands;
  onBack: () => void;
  onClose: () => void;
  setChrome: CustomModalInjectedProps['setChrome'];
}>) {
  const read = useRegistryItem({ kind: 'app', sourceId: props.item.sourceId, itemId: props.item.itemId,
    ...(props.item.version ? { version: props.item.version } : {}) }, true);
  const item = read.stale ? null : read.item;
  const templateRef = item && item.payload.kind === 'app' && item.payload.state !== 'needs_review' && item.summary.version
    ? { sourceId: item.summary.sourceId, itemId: item.summary.itemId, version: item.summary.version, ref: item.payload.ref } : null;
  const needsReview = item?.payload.kind === 'app' && item.payload.state === 'needs_review';
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime, props.detail.environment.projectSourceId),
    [props.lifetime, props.detail.environment.projectSourceId]);
  const [preflight, setPreflight] = React.useState<Preflight>({ status: 'checking' });
  const [added, setAdded] = React.useState(false);
  const refKey = templateRef ? JSON.stringify(templateRef) : null;
  const operandsKey = JSON.stringify(props.operands);
  // The review's preview is the preflight: one read per chosen template, never repeated on its own.
  React.useEffect(() => {
    if (!templateRef) return;
    let live = true;
    setPreflight({ status: 'checking' });
    actions.instantiateTemplate({ ...props.operands, mode: 'preview', templateRef }).then((result) => {
      if (!live) return;
      if (result.kind !== 'preview') { setPreflight({ status: 'failed', code: 'invalid_response' }); return; }
      setPreflight({ status: 'ready', firstRun: result.review.firstRunSetup === true,
        shortOn: (result.review.capacity ?? []).filter((entry) => entry.state === 'shortfall').map((entry) => entry.resource) });
    }, (error) => {
      if (!live) return;
      const outcome = readDeploymentActionError(error);
      setPreflight({ status: 'failed', code: outcome.kind === 'refused' ? outcome.code : 'unknown_error' });
    });
    return () => { live = false; };
    // The serialized ref and operands are the preview's identity.
  }, [actions, refKey, operandsKey]);
  const press = useDeploymentChangePress({ request: (artifactId) => { props.onClose(); props.review.request(artifactId); } },
    () => setAdded(true));
  const add = () => {
    if (!templateRef) return;
    void press.press(async () => {
      await actions.instantiateTemplate({ ...props.operands, mode: 'apply', templateRef, deploy: { requestKey: randomUUID() } });
      return { ok: true };
    });
  };
  const title = props.item.title;
  const footer = added ? (
    <ModalCardFooterActions>
      <RoundButton testID="project-deployments.add.done" size="normal" title={t('common.done')} onPress={props.onClose} />
    </ModalCardFooterActions>
  ) : (
    <ModalCardFooterActions cancel={{ onPress: props.onClose, testID: 'project-deployments.add.cancel', disabled: press.running }}>
      <RoundButton testID="project-deployments.add.back" size="normal" display="secondary" disabled={press.running}
        title={t('projects.deployments.addBack')} onPress={props.onBack} />
      <RoundButton testID="project-deployments.add.confirm" size="normal" title={t('projects.deployments.addConfirm')}
        disabled={!templateRef || preflight.status !== 'ready' || press.running} loading={press.running} onPress={add} />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.add.review" style={deploymentSheetStyles.body}>
        {added ? (
          <>
            <SurfaceStateCard testID="project-deployments.add.added" size="details" layout="inline" kind="success"
              title={t('projects.deployments.addAdded', { name: title })} />
            {preflight.status === 'ready' && preflight.firstRun ? (
              <SurfaceStateCard testID="project-deployments.add.firstRun" size="details" layout="inline" kind="empty"
                title={t('projects.deployments.addFirstRunTitle')} reason={t('projects.deployments.addFirstRunBody')} />
            ) : null}
          </>
        ) : (
          <>
            <ItemGroup testID="project-deployments.add.facts" header="none">
              <Item testID="project-deployments.add.template" title={title} subtitle={props.item.description ?? undefined} mode="info" />
              <Item testID="project-deployments.add.where" title={t('projects.deployments.machine')} detail={props.machine} mode="info" />
              <Item testID="project-deployments.add.preflight" title={t('projects.deployments.addPreflight')} mode="info"
                detail={preflight.status === 'checking' ? t('projects.deployments.addChecking')
                  : preflight.status === 'failed' ? t('projects.deployments.addRefused')
                    : preflight.shortOn.length === 0 ? t('projects.deployments.addRoomOk') : undefined}
                {...(preflight.status === 'ready' && preflight.shortOn.length > 0 ? { subtitle: t(preflight.shortOn.includes('memoryBytes')
                  ? 'projects.deployments.addShortMemory' : 'projects.deployments.addShortDisk') } : {})} />
            </ItemGroup>
            {needsReview ? <SurfaceStateCard testID="project-deployments.add.needsReview" size="line" kind="unavailable"
              title={t('projects.deployments.addNeedsReview')} /> : null}
            {preflight.status === 'failed' ? <SurfaceStateCard testID="project-deployments.add.preflightFailed" size="line"
              kind="error" title={t('projects.deployments.addRefused')} reason={deploymentActionRefusalRemedy(preflight.code)}
              diagnosticCode={preflight.code} /> : null}
            {press.outcome?.kind === 'refused' ? <SurfaceStateCard testID="project-deployments.add.refused" size="line" kind="error"
              title={t('projects.deployments.addRefused')} reason={deploymentActionRefusalRemedy(press.outcome.code)}
              diagnosticCode={press.outcome.code} /> : null}
          </>
        )}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
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
  setBindings: (input: Parameters<DeploymentSetBindings>[0]) => Promise<unknown>;
  review: DeploymentReviewHandle;
}> & CustomModalInjectedProps) {
  const [destination, setDestination] = React.useState<Readonly<{ id: string; revision: number; title: string }> | null>(null);
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
    void press.press(async () => {
      await props.setBindings({ environmentId: destination.id, expectedRevision: destination.revision, remove: [],
        set: [{ purpose: 'variable', name: variable, phase: 'runtime',
          source: { kind: 'reference', environmentId: props.sourceEnvironmentId, export: exportKey, via: 'auto' } }] });
      return { ok: true };
    });
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
            title={t('projects.deployments.databaseConnectNeedsShare')} />
        ) : (
          <>
            <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseConnectLead')}</Text>
            <DeploymentEnvironmentChooser controller={props.controller} testID="project-deployments.connect.destination"
              title={t('projects.deployments.databaseConnectDestination')}
              eligible={(row) => row.environment.id !== props.sourceEnvironmentId && row.environment.capabilities.manage}
              selectedId={destination?.id ?? null} disabled={busy}
              onSelect={(row) => setDestination({ id: row.environment.id, revision: row.environment.revision, title: row.title })}
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
  }>,
) {
  const { data, detail } = props;
  const exports = (detail.content.ownServer?.serviceExports ?? []).filter(
    (entry) => entry.service === data.service,
  );
  const shared = exports.find((entry) => entry.exposure === 'privateNetwork');
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
          shared ? undefined : t('projects.deployments.databaseNotSharedDetail')
        }
        detail={
          shared?.privateNetwork
            ? t('projects.deployments.databasePrivateShared', {
                network: shared.privateNetwork,
              })
            : t('projects.deployments.databaseNotShared')
        }
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
  choose: { flex: 1, minHeight: 0 },
  page: { flex: 1, minHeight: 0 },
}));

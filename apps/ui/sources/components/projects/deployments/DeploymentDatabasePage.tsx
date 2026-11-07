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
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { createDeploymentActions } from './deploymentActions';
import {
  deploymentDataTargetOperands,
  deploymentRestoreOperands,
  retainedBackupFromSummary,
} from './deploymentRestore';
import {
  showDeploymentRestoreSheet,
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
  const openRestore =
    restoreAction && retainedBackup && restoreOperands
      ? () =>
          showDeploymentRestoreSheet({
            name: detail.content.name,
            machine: machineName(restoreOperands.machineId),
            backup: retainedBackup,
            operands: restoreOperands,
            restore: restoreAction,
            onApproval: props.review.request,
          })
      : null;

  const lastGood = ready?.history?.lastSuccessfulBackup ?? null;

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
              {openRestore ? null : (
                <Item
                  testID={`${id}.restoreNone`}
                  title={t('projects.deployments.databaseRestoreNone')}
                  mode="info"
                />
              )}
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
  page: { flex: 1, minHeight: 0 },
}));

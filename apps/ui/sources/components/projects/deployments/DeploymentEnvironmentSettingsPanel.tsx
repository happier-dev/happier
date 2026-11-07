import { EnvironmentMachineChoice } from './EnvironmentMachineChoice';
export { EnvironmentMachineChoice } from './EnvironmentMachineChoice';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DeploymentEnvironmentReadDetailV1,
  DeploymentEnvironmentSettingsSectionV1,
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol/v1';

import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useSettingReveal } from '@/components/settings/shell/SettingRow';
import { NewAccountTriggerPopover } from '@/components/workflows/triggers/AccountTriggersSection';
import { guidedStarterEventSeed } from '@/components/workflows/triggers/guidedAutomation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import type { DeploymentRetainedBackup } from './deploymentRestore';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { DeploymentTabState } from './DeploymentTabState';
import {
  DeploymentBackupControls,
  DeploymentBackupDestinationRow,
  DeploymentBackupRetentionRows,
  DeploymentBackupSetup,
  DeploymentBackupCredentialRows,
  DeploymentBackupScheduleRow,
} from './DeploymentBackupControls';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { createDeploymentActions } from './deploymentActions';
import { DeployOutcomeBanner, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { useDeploymentEnvironmentPreviews } from './useDeploymentProject';
import {
  useDeploymentEnvironmentBackups,
  useDeploymentEnvironmentChecks,
} from './useDeploymentReads';

const noop = () => {};

/** What a manager can change from Settings and Permissions, through the Action owner. */
export type DeploymentEnvironmentEditing = Readonly<{
  actions: Pick<ReturnType<typeof createDeploymentActions>, 'setController' | 'updateEnvironment'>;
  serverId: string;
  review: DeploymentReviewHandle;
  /** A settled change moved the Environment's revision: re-read it. */
  onChanged: () => void;
}>;

/**
 * Environment → Settings (lab r7 `envsettings/page`): the six P40-R54 sections in their canonical order.
 * Servers & build summarises where it runs (health and Add a server stay on Overview); Variables, Domains and
 * Permissions are tabs, so they are not repeated here. Sections whose owner has not landed state that nothing
 * is set up rather than drawing a form that cannot save.
 */
export const DeploymentEnvironmentSettingsPanel = React.memo(
  function DeploymentEnvironmentSettingsPanel(
    props: Readonly<{
      detail: DeploymentEnvironmentReadDetailV1;
      controller: DeploymentReadControllerV1;
      demand: DeploymentReadDemandV1;
      machineName: (machineId: string) => string;
      /** Names the template a preview was made from, from the page's Environment list. */
      environmentTitle: (environmentId: string) => string | null;
      /** A section another tab linked to (Permissions → Controller); it scrolls into view when the tab opens. */
      focusSection?: DeploymentEnvironmentSettingsSectionV1 | null;
      /** Opens the irreversible Unlink review for a target; null where this viewer cannot remove it. */
      onUnlink?: ((targetLinkId: string) => void) | null;
      /** Opens the Link a machine sheet; null where this viewer cannot link one. */
      onLink?: (() => void) | null;
      /** Opens the Add platform target sheet; null where this viewer cannot link one. */
      onAddPlatform?: (() => void) | null;
      /** The backup the serving deploy kept before its migration, with the restore sheet that replaces data with it. */
      retainedBackup?: DeploymentRetainedBackup | null;
      onRestore?: (() => void) | null;
      /** The captured Home/Account the template's preview list reads under; absent while it is not current. */
      lifetime?: ServerAccountScopeLifetime | null;
      /** The Action owner's manager edits; absent where this viewer cannot change settings. */
      editing?: DeploymentEnvironmentEditing | null;
      review?: DeploymentReviewHandle;
      /** Opens a Machine's Services page (health checks); absent where no Home is known. */
      onOpenMachineServices?: ((machineId: string) => void) | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const editing = props.detail.environment.capabilities.role === 'manager' ? props.editing ?? null : null;
    const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
    const controllerReveal = useSettingReveal(props.focusSection === 'controller', 0);
    const { detail, machineName } = props;
    const runtimeMachines = detail.runtimeTargetLink?.machines ?? [];
    const runtimeLinkId = detail.runtimeTargetLink?.id ?? null;
    const platformSource = detail.runtimeTargetLink?.source.kind === 'plugin' ? detail.runtimeTargetLink.source : null;
    // A row's subtitle is styled text only as a string; the descriptor's own name, or its kind until that loads.
    const platformTitle = useDeploymentPlatformTargetTitles(props.lifetime ?? null, platformSource !== null);
    const platformName = platformSource ? platformTitle(platformSource) ?? detail.runtimeTargetLink?.targetKind : undefined;
    const { onUnlink, onLink, onAddPlatform } = props;
    const buildMachineId = detail.environment.buildMachineId;
    const ownServer = detail.content.ownServer;
    const machineIcon = (
      <Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />
    );
    const section = (id: DeploymentEnvironmentSettingsSectionV1) =>
      `project-deployments.environment.settings.${id}`;
    const rolloutOptions: ReadonlyArray<SegmentedChoiceOption<'recreate' | 'startFirst'>> = [
      { id: 'recreate', label: t('projects.deployments.settingsSections.rolloutRecreateShort') },
      { id: 'startFirst', label: t('projects.deployments.settingsSections.rolloutStartFirstShort') },
    ];
    const checkLifetime = editing ? props.lifetime ?? null : null;
    const checkAnchor = React.useRef<View>(null);
    const [openingCheckSetup, setOpeningCheckSetup] = React.useState(false);

    return (
      <>
        {/* The page lead (lab r7 `envsettings/page`): what Settings holds and where the rest lives. */}
        <ItemGroup
          testID="project-deployments.environment.settings.lead"
          surface="none"
          description={t('projects.deployments.settingsDescription', { name: detail.content.name })}
        >
          <Item testID="project-deployments.environment.settings.account-defaults"
            title={t('projects.deployments.defaultsEditor.accountLink')}
            icon={<Icon name="sliders-horizontal" size={18} color={theme.colors.text.secondary} />}
            onPress={() => router.push({ pathname: SETTINGS_ROUTES.deployments,
              params: { serverId: props.detail.environment.serverId } })} />
        </ItemGroup>
        {change.outcome && editing ? (
          <DeployOutcomeBanner
            outcome={change.outcome}
            pending={change.outcome.kind === 'approval' && editing.review.pendingId === change.outcome.artifactId}
            machine={machineName(detail.environment.controllerMachineId)}
            onOpenReview={editing.review.open}
            copy="setting"
          />
        ) : null}
        <ItemGroup
          testID={section('servers-build')}
          title={t('projects.deployments.sectionServersBuild')}
          description={t('projects.deployments.sectionServersBuildDescription')}
          // Nothing runs it yet: a platform is the other way to give it somewhere to run.
          action={onAddPlatform && !runtimeLinkId ? (
            <SectionActionButton
              testID={`${section('servers-build')}.addPlatform`}
              title={t('projects.deployments.platformLink.add')}
              icon="cloud"
              onPress={onAddPlatform}
            />
          ) : undefined}
        >
          {platformSource && runtimeLinkId ? (
            <Item
              testID={`${section('servers-build')}.platform`}
              icon={<Icon name="cloud" size={18} color={theme.colors.text.secondary} />}
              title={t('projects.deployments.runsOn')}
              subtitle={platformName}
              mode="info"
              rightElement={onUnlink ? (
                <SectionActionButton
                  testID={`${section('servers-build')}.unlink`}
                  title={t('projects.deployments.unlinkAction')}
                  icon="link-break"
                  onPress={() => onUnlink(runtimeLinkId)}
                />
              ) : undefined}
            />
          ) : runtimeMachines.length > 0 ? (
            <Item
              icon={machineIcon}
              title={t('projects.deployments.runsOn')}
              subtitle={runtimeMachines.map(machineName).join(', ')}
              mode="info"
              rightElement={onUnlink && runtimeLinkId ? (
                <SectionActionButton
                  testID={`${section('servers-build')}.unlink`}
                  title={t('projects.deployments.unlinkAction')}
                  icon="link-break"
                  onPress={() => onUnlink(runtimeLinkId)}
                />
              ) : undefined}
            />
          ) : (
            // Nothing is linked: the row says so and links one, where Unlink would otherwise sit.
            <Item
              icon={machineIcon}
              title={t('projects.deployments.runsOn')}
              subtitle={t('projects.deployments.runsOnNone')}
              mode="info"
              rightElement={onLink ? (
                <SectionActionButton
                  testID={`${section('servers-build')}.link`}
                  title={t('projects.deployments.linkAction')}
                  icon="link"
                  onPress={onLink}
                />
              ) : undefined}
            />
          )}
          {editing ? (
            <EnvironmentMachineChoice
              testID={`${section('servers-build')}.buildsOn`}
              serverId={editing.serverId}
              icon={machineIcon}
              title={t('projects.deployments.buildsOn')}
              currentMachineId={buildMachineId ?? null}
              fallback={t('projects.deployments.buildsOnTarget')}
              disabled={change.running}
              onChoose={(machineId) => {
                void change.press(() => editing.actions.updateEnvironment(detail.environment, { buildMachineId: machineId }));
              }}
            />
          ) : (
            <Item
              icon={machineIcon}
              title={t('projects.deployments.buildsOn')}
              subtitle={
                buildMachineId
                  ? machineName(buildMachineId)
                  : t('projects.deployments.buildsOnTarget')
              }
              mode="info"
            />
          )}
        </ItemGroup>

        <View ref={controllerReveal.hostRef} collapsable={false}>
        <ItemGroup
          testID={section('controller')}
          title={t('projects.deployments.sectionController')}
          description={t('projects.deployments.sectionControllerDescription')}
        >
          {editing ? (
            <EnvironmentMachineChoice
              testID={`${section('controller')}.machine`}
              serverId={editing.serverId}
              icon={machineIcon}
              title={t('projects.deployments.controllerRow')}
              currentMachineId={detail.environment.controllerMachineId}
              fallback={machineName(detail.environment.controllerMachineId)}
              disabled={change.running}
              onChoose={(machineId) => {
                void change.press(() => editing.actions.setController(detail.environment, machineId));
              }}
            />
          ) : (
            <Item
              icon={machineIcon}
              title={t('projects.deployments.controllerRow')}
              subtitle={machineName(detail.environment.controllerMachineId)}
              mode="info"
            />
          )}
        </ItemGroup>
        </View>

        <ItemGroup
          testID={section('rollout')}
          title={t('projects.deployments.sectionRollout')}
          description={t('projects.deployments.sectionRolloutDescription')}
        >
          {ownServer && editing ? (
            <>
              {/* How it deploys (lab review/howitdeploys): each choice saves once through environments.update. */}
              <SegmentedChoiceItem<'recreate' | 'startFirst'>
                testID={`${section('rollout')}.rollout`}
                testIDPrefix={`${section('rollout')}.rollout`}
                title={t('projects.deployments.sectionRollout')}
                subtitle={ownServer.rollout === 'startFirst'
                  ? t('projects.deployments.rolloutStartFirst')
                  : t('projects.deployments.rolloutRecreate')}
                accessoryLayout="adaptive"
                options={rolloutOptions}
                value={ownServer.rollout}
                disabled={change.running}
                onChange={(rollout) => {
                  void change.press(() => editing.actions.updateEnvironment(detail.environment, { ownServer: { rollout } }));
                }}
              />
              <Item
                testID={`${section('rollout')}.restore`}
                title={t('projects.deployments.restoreOnFail')}
                subtitle={ownServer.autoRestorePreviousRelease
                  ? t('projects.deployments.settingsSections.restoreOnFailOnBody')
                  : t('projects.deployments.settingsSections.restoreOnFailOffBody')}
                rightElement={
                  <Switch
                    value={ownServer.autoRestorePreviousRelease}
                    disabled={change.running}
                    onValueChange={(autoRestorePreviousRelease) => {
                      void change.press(() => editing.actions.updateEnvironment(detail.environment,
                        { ownServer: { autoRestorePreviousRelease } }));
                    }}
                  />
                }
              />
            </>
          ) : ownServer ? (
            <>
              <Item
                title={t('projects.deployments.sectionRollout')}
                subtitle={
                  ownServer.rollout === 'startFirst'
                    ? t('projects.deployments.rolloutStartFirst')
                    : t('projects.deployments.rolloutRecreate')
                }
                mode="info"
              />
              <Item
                title={t('projects.deployments.restoreOnFail')}
                detail={
                  ownServer.autoRestorePreviousRelease
                    ? t('projects.deployments.restoreOnFailOn')
                    : t('projects.deployments.restoreOnFailOff')
                }
                mode="info"
              />
            </>
          ) : null}
          {editing ? (
            <FieldValueItem
              testID={`${section('rollout')}.kept`}
              fieldTestID={`${section('rollout')}.kept.input`}
              title={t('projects.deployments.keptForRollback')}
              subtitle={t('projects.deployments.settingsSections.keptBody')}
              kind="integer"
              value={String(detail.content.retainPreviousDeployments)}
              stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }}
              compactStepper
              disabled={change.running}
              onCommit={(draft) => {
                const count = Number(draft.trim());
                if (draft.trim() !== '' && Number.isSafeInteger(count) && count >= 0
                  && count !== detail.content.retainPreviousDeployments) {
                  void change.press(() => editing.actions.updateEnvironment(detail.environment,
                    { retainPreviousDeployments: count }));
                }
                // The settled Environment re-read replaces this value.
                return String(detail.content.retainPreviousDeployments);
              }}
            />
          ) : (
            <Item
              title={t('projects.deployments.keptForRollback')}
              detail={t('projects.deployments.keptCount', {
                count: detail.content.retainPreviousDeployments,
              })}
              mode="info"
            />
          )}
        </ItemGroup>

        <ItemGroup
          testID={section('checks-alerts')}
          title={t('projects.deployments.sectionChecks')}
          description={t('projects.deployments.sectionChecksDescription')}
          action={checkLifetime ? (
            <View ref={checkAnchor} collapsable={false}>
              <SectionActionButton
                testID={`${section('checks-alerts')}.add`}
                title={t('projects.deployments.settingsSections.addCheck')}
                icon="plus"
                expanded={openingCheckSetup}
                onPress={() => setOpeningCheckSetup(true)}
              />
            </View>
          ) : undefined}
        >
          {/* Health is what deployed services report; where nothing runs there is nothing to read yet. */}
          {detail.runtimeTargetLink?.activeDeploymentId ? (
            <ChecksRows {...props} testID={section('checks-alerts')} />
          ) : (
            <Item
              testID={`${section('checks-alerts')}.notDeployed`}
              title={t('projects.deployments.checksNotDeployed')}
              mode="info"
            />
          )}
        </ItemGroup>
        {openingCheckSetup && checkLifetime ? (
          <NewAccountTriggerPopover
            anchorRef={checkAnchor}
            onRequestClose={() => setOpeningCheckSetup(false)}
            accountLifetime={checkLifetime}
            initialProject={{ machineId: detail.environment.controllerMachineId, directory: '~' }}
            eventSeed={guidedStarterEventSeed('healthFailed', {
              subject: { kind: 'environment', environmentId: detail.environment.id,
                machineId: detail.environment.controllerMachineId },
              controllerMachineId: detail.environment.controllerMachineId,
            })}
          />
        ) : null}
        <ItemGroup
          testID={section('backups')}
          title={t('projects.deployments.sectionBackups')}
          description={t('projects.deployments.sectionBackupsDescription')}
        >
          <BackupRows {...props} testID={section('backups')} />
        </ItemGroup>
        {detail.environment.purpose === 'preview' || props.lifetime || detail.content.previewTemplate ? (
          <ItemGroup
            testID={section('previews')}
            title={t('projects.deployments.sectionPreviews')}
            description={t('projects.deployments.sectionPreviewsDescription')}
          >
            {detail.environment.purpose !== 'preview' ? (
              <PreviewTemplateRows
                detail={detail}
                machineName={machineName}
                onSave={editing ? (next) => {
                  void change.press(() => editing.actions.updateEnvironment(detail.environment, { previewTemplate: next }));
                } : null}
                saving={change.running}
                lifetime={props.lifetime ?? null}
                testID={`${section('previews')}.template`}
              />
            ) : null}
            {detail.environment.purpose === 'preview' ? (
              <PreviewOfRow {...props} testID={section('previews')} />
            ) : props.lifetime && detail.content.previewTemplate ? (
              <TemplatePreviewRows
                lifetime={props.lifetime}
                demand={props.demand}
                environmentId={detail.environment.id}
                testID={section('previews')}
              />
            ) : null}
          </ItemGroup>
        ) : null}
      </>
    );
  },
);

type SectionProps = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  machineName: (machineId: string) => string;
  environmentTitle: (environmentId: string) => string | null;
  retainedBackup?: DeploymentRetainedBackup | null;
  /** Opens a Machine's Services page (health checks); absent where no Home is known. */
  onOpenMachineServices?: ((machineId: string) => void) | null;
  onRestore?: (() => void) | null;
  lifetime?: ServerAccountScopeLifetime | null;
  review?: DeploymentReviewHandle;
  editing?: DeploymentEnvironmentEditing | null;
  testID: string;
}>;

/**
 * Checks & alerts: what the Machines running this Environment report about each service now. Only native service
 * health is published; monitors of other kinds and alert routing are not, so they are not drawn as if set up.
 */
function ChecksRows(props: SectionProps) {
  const checks = useDeploymentEnvironmentChecks(props.controller, props.detail.environment.id, props.demand);
  const members = checks.result.items.filter((member) => member.status !== 'unavailable');
  return (
    <>
      {members.map((member) => {
        const failing = member.services.filter((service) => service.state === 'down' || service.state === 'degraded');
        const summary = member.status === 'loading' || member.services.every((service) => service.state === 'unknown')
          ? t('projects.deployments.checksWaiting')
          : failing.length > 0
            ? t('projects.deployments.checksFailing', { names: failing.map((service) => service.name ?? service.serviceId).join(', ') })
            : t('projects.deployments.checksAllPassing');
        return (
          <Item
            key={`${member.machineId}:${member.installationId}`}
            testID={`${props.testID}.member.${member.machineId}`}
            title={member.services.length > 0
              ? t('projects.deployments.checksServices', { count: member.services.length })
              : t('projects.deployments.checksNoServices')}
            subtitle={t('projects.deployments.checksOnMachine', { summary, machine: props.machineName(member.machineId) })}
            rightElement={failing.length > 0
              ? <StatusPill variant="danger" label={t('projects.deployments.healthUnhealthy')} />
              : undefined}
            // The checks are the Machine's own services (lab r7 `Health checks` →): they are set up there.
            {...(props.onOpenMachineServices
              ? { showChevron: true, onPress: () => props.onOpenMachineServices!(member.machineId) }
              : { mode: 'info' as const })}
          />
        );
      })}
      <DeploymentTabState
        result={checks.result}
        testID={props.testID}
        errorTitle={t('projects.deployments.checksErrorTitle')}
        emptyTitle={t('projects.deployments.checksNoServices')}
      />
      {checks.result.status === 'ready' || checks.result.status === 'empty' ? (
        <Item
          testID={`${props.testID}.alerts`}
          title={t('projects.deployments.alertsRow')}
          detail={t('projects.deployments.notAvailableYet')}
          mode="info"
        />
      ) : null}
    </>
  );
}

/**
 * Saved backup configuration, with explicit run and integrity verification Actions. Historical status is
 * not inferred from configuration or from a successful integrity check.
 */
function BackupRows(props: SectionProps) {
  const backups = useDeploymentEnvironmentBackups(props.controller, props.detail.environment.id, props.demand);
  const backup = backups.result.items[0];
  const manager = props.detail.environment.capabilities.role === 'manager';
  const { lifetime } = props;
  const projectSourceId = props.detail.environment.projectSourceId;
  // The backup Actions run under the page's captured Home/Account; a viewer who cannot manage sees the facts only.
  const actions = React.useMemo(() => manager && lifetime && props.review
    ? createDeploymentActions(lifetime, projectSourceId) : null, [manager, lifetime, props.review, projectSourceId]);
  const editing = manager ? props.editing ?? null : null;
  const retentionChange = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
  const saveRetention = React.useMemo(() => editing && backup && !('notNeeded' in backup)
    ? (retention: DeploymentBackupConfigurationV1['retention']) => retentionChange.press(() =>
      editing.actions.updateEnvironment(props.detail.environment,
        { backupRetention: { configRevision: backup.configRevision, retention } }))
    : null, [editing, backup, retentionChange.press, props.detail.environment]);
  if (!backup && backups.result.status === 'empty' && editing && actions) {
    return (
      <>
        <DeploymentBackupSetup
          detail={props.detail}
          testID={props.testID}
          onSave={(configuration) => retentionChange.press(() =>
            editing.actions.updateEnvironment(props.detail.environment, { backup: configuration }))}
        />
        {retentionChange.outcome ? (
          <DeployOutcomeBanner
            outcome={retentionChange.outcome}
            pending={retentionChange.outcome.kind === 'approval' && editing.review.pendingId === retentionChange.outcome.artifactId}
            machine={props.machineName(props.detail.environment.controllerMachineId)}
            onOpenReview={editing.review.open}
            copy="setting"
          />
        ) : null}
      </>
    );
  }
  if (!backup || backups.result.status !== 'ready') {
    return (
      <DeploymentTabState
        result={backups.result}
        testID={props.testID}
        errorTitle={t('projects.deployments.backupsErrorTitle')}
        emptyTitle={t('projects.deployments.settingsSections.backupNotSetUpBody')}
      />
    );
  }
  if ('notNeeded' in backup) {
    return (
      <Item
        testID={`${props.testID}.notNeeded`}
        title={t('projects.deployments.backupNotNeededTitle')}
        subtitle={t('projects.deployments.backupNotNeededBody', { name: props.detail.content.name })}
        mode="info"
      />
    );
  }
  return (
    <>
      <DeploymentBackupDestinationRow detail={props.detail} configuration={backup} actions={actions} testID={props.testID} />
      <DeploymentBackupCredentialRows
        detail={props.detail} configuration={backup} lifetime={actions ? props.lifetime ?? null : null}
        actions={actions} review={props.review ?? null} onChanged={editing?.onChanged ?? noop}
        machineName={props.machineName} testID={props.testID}
      />
      <DeploymentBackupScheduleRow detail={props.detail} configuration={backup} actions={actions} testID={props.testID} />
      <Item
        testID={`${props.testID}.sources`}
        title={t('projects.deployments.backupSources')}
        subtitle={backup.sources.map((source) => source.kind === 'dump'
          ? t('projects.deployments.backupSourceDump', { service: source.service })
          : t('projects.deployments.backupSourceVolume', { service: source.service, volume: source.volume })).join(', ')}
        mode="info"
      />
      <DeploymentBackupRetentionRows
        key={`${backup.configRevision}:${props.detail.environment.revision}`}
        detail={props.detail} configuration={backup} label={retentionLabel(backup.retention)}
        onSave={saveRetention} actions={actions} review={props.review ?? null}
        machineName={props.machineName} testID={props.testID}
      />
      {retentionChange.outcome && editing ? (
        <DeployOutcomeBanner
          outcome={retentionChange.outcome}
          pending={retentionChange.outcome.kind === 'approval' && editing.review.pendingId === retentionChange.outcome.artifactId}
          machine={props.machineName(props.detail.environment.controllerMachineId)}
          onOpenReview={editing.review.open}
          copy="setting"
        />
      ) : null}
      <Item
        testID={`${props.testID}.status`}
        title={t('projects.deployments.backupStatusTitle')}
        subtitle={backups.statusRead.status === 'unavailable'
          ? t('projects.deployments.backupStatusUnavailable')
          : undefined}
        mode="info"
      />
      {props.lifetime && props.review && props.detail.environment.capabilities.role === 'manager' ? (
        <DeploymentBackupControls
          key={`${props.lifetime.scope.serverId}:${props.lifetime.scope.accountId}:${props.detail.environment.id}:${props.detail.environment.revision}:${props.detail.runtimeTargetLink?.activeDeploymentId}:${backup.configRevision}`}
          detail={props.detail} configuration={backup} lifetime={props.lifetime}
          review={props.review}
          machineName={props.machineName} testID={props.testID}
        />
      ) : null}
      {props.retainedBackup && props.onRestore ? (
        <Item
          testID={`${props.testID}.restore`}
          title={t('projects.deployments.restoreEntry')}
          subtitle={props.retainedBackup.versionLabel
            ? t('projects.deployments.restoreBackupBefore', { version: props.retainedBackup.versionLabel,
              time: formatAsOfTime(props.retainedBackup.takenAtMs) })
            : t('projects.deployments.restoreBackupTaken', { time: formatAsOfTime(props.retainedBackup.takenAtMs) })}
          mode="info"
          rightElement={
            <SectionActionButton
              testID={`${props.testID}.restore.open`}
              title={t('projects.deployments.restoreAction')}
              icon="clock-counter-clockwise"
              onPress={props.onRestore}
            />
          }
        />
      ) : null}
    </>
  );
}

function retentionLabel(retention: DeploymentBackupConfigurationV1['retention']): string {
  if (retention.kind === 'keepEverything') return t('projects.deployments.backupKeepEverything');
  return [
    retention.last !== undefined ? t('projects.deployments.backupKeepLast', { count: retention.last }) : null,
    retention.daily !== undefined ? t('projects.deployments.backupKeepDaily', { count: retention.daily }) : null,
    retention.weekly !== undefined ? t('projects.deployments.backupKeepWeekly', { count: retention.weekly }) : null,
    retention.monthly !== undefined ? t('projects.deployments.backupKeepMonthly', { count: retention.monthly }) : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

/**
 * The preview template this Environment carries (lab `d5d/template`, `previewdb/template`, `previewdb/branch`,
 * `d5d/prodmachine`): whether new pull requests get previews, where they run, their address pattern and their data.
 * Read from the Environment's own content; forks never get previews, which is a fact rather than a choice here.
 */
type PreviewTemplate = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>;
type PreviewData = 'own' | 'branch' | 'none';

function previewDataKind(template: PreviewTemplate): PreviewData {
  const data = template.data[0];
  return !data ? 'none' : data.kind === 'managed' ? 'branch' : 'own';
}

function PreviewTemplateRows(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  machineName: (machineId: string) => string;
  /** Saves the whole next template once through `environments.update` (patch.previewTemplate); absent for viewers. */
  onSave: ((next: PreviewTemplate) => void) | null;
  saving: boolean;
  /** The captured Home/Account the Project repository is read under; absent while it is not current. */
  lifetime: ServerAccountScopeLifetime | null;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const template = props.detail.content.previewTemplate;
  const onSaveTemplate = props.onSave;
  // The saved data selections this page has seen, so switching to None and back keeps the exact choice.
  const [seenData, setSeenData] = React.useState<Readonly<Partial<Record<'own' | 'branch', PreviewTemplate['data']>>>>({});
  React.useEffect(() => {
    const kind = template ? previewDataKind(template) : 'none';
    if (template && kind !== 'none') setSeenData((seen) => seen[kind] === template.data ? seen : { ...seen, [kind]: template.data });
  }, [template]);
  if (!template) {
    return <PreviewSetupRow detail={props.detail} lifetime={props.lifetime} onSave={onSaveTemplate} saving={props.saving}
      testID={props.testID} />;
  }
  const { onSave } = props;
  const runtimeLinks = props.detail.targetLinks.map((row) => row.targetLink).filter((link) => link.role === 'runtime');
  const linkName = (link: (typeof runtimeLinks)[number] | undefined) => {
    const machines = link && 'machines' in link && Array.isArray(link.machines) ? link.machines.map(props.machineName) : [];
    return machines.join(', ') || link?.targetKind || '';
  };
  const link = runtimeLinks.find((candidate) => candidate.id === template.runtimeTargetLinkId);
  const sharesProduction = template.runtimeTargetLinkId === (props.detail.environment.runtimeTargetLinkId ?? props.detail.runtimeTargetLink?.id);
  const dataKind = previewDataKind(template);
  const save = (patch: Partial<PreviewTemplate>) => onSave?.({ ...template, ...patch });
  const unavailable = t('projects.deployments.settingsSections.previewsDataUnavailable');
  const dataOptions: ReadonlyArray<SegmentedChoiceOption<PreviewData>> = [
    { id: 'own', label: t('projects.deployments.settingsSections.previewsDataOwn'),
      disabled: !seenData.own && dataKind !== 'own', unavailableReason: unavailable },
    { id: 'branch', label: t('projects.deployments.settingsSections.previewsDataBranch'),
      disabled: !seenData.branch && dataKind !== 'branch', unavailableReason: unavailable },
    { id: 'none', label: t('projects.deployments.settingsSections.previewsDataNone') },
  ];
  const runsOnSubtitle = sharesProduction ? t('projects.deployments.settingsSections.previewsProductionMachine') : undefined;
  const runsOnLeading = sharesProduction ? <StatusDot size={6} color={theme.colors.state.warning.foreground} /> : undefined;
  return (
    <>
      <Item
        testID={`${props.testID}.enabled`}
        title={t('projects.deployments.settingsSections.previewsTitle')}
        subtitle={template.enabled
          ? t('projects.deployments.settingsSections.previewsOn')
          : t('projects.deployments.settingsSections.previewsOff')}
        mode={onSave ? undefined : 'info'}
        rightElement={onSave ? (
          <Switch value={template.enabled} disabled={props.saving}
            onValueChange={(enabled) => save({ enabled })} />
        ) : undefined}
      />
      {onSave && runtimeLinks.length > 1 && runtimeLinks.length <= 4 ? (
        <SegmentedChoiceItem<string>
          testID={`${props.testID}.runsOn`}
          testIDPrefix={`${props.testID}.runsOn`}
          title={t('projects.deployments.settingsSections.previewsRunsOn')}
          subtitle={runsOnSubtitle}
          subtitleLeading={runsOnLeading}
          accessoryLayout="adaptive"
          options={runtimeLinks.map((candidate) => ({ id: candidate.id, label: linkName(candidate) }))}
          value={template.runtimeTargetLinkId}
          disabled={props.saving}
          onChange={(runtimeTargetLinkId) => save({ runtimeTargetLinkId })}
        />
      ) : (
        <Item
          testID={`${props.testID}.runsOn`}
          title={t('projects.deployments.settingsSections.previewsRunsOn')}
          subtitle={runsOnSubtitle}
          subtitleLeading={runsOnLeading}
          detail={linkName(link)}
          mode="info"
        />
      )}
      {template.domain ? (
        onSave ? (
          <FieldValueItem
            testID={`${props.testID}.address`}
            fieldTestID={`${props.testID}.address.input`}
            title={t('projects.deployments.settingsSections.previewsAddress')}
            accessoryLayout="stacked"
            monospace
            autoCapitalize="none"
            value={template.domain.hostnamePattern}
            disabled={props.saving}
            onCommit={(draft) => {
              const hostnamePattern = draft.trim();
              if (template.domain && hostnamePattern !== '' && hostnamePattern !== template.domain.hostnamePattern) {
                save({ domain: { ...template.domain, hostnamePattern } });
              }
              // The settled Environment re-read replaces this value.
              return template.domain?.hostnamePattern ?? '';
            }}
          />
        ) : (
          <Item
            testID={`${props.testID}.address`}
            title={t('projects.deployments.settingsSections.previewsAddress')}
            detail={template.domain.hostnamePattern}
            mode="info"
          />
        )
      ) : null}
      {onSave ? (
        <SegmentedChoiceItem<PreviewData>
          testID={`${props.testID}.data`}
          testIDPrefix={`${props.testID}.data`}
          title={t('projects.deployments.settingsSections.previewsData')}
          accessoryLayout="adaptive"
          options={dataOptions}
          value={dataKind}
          disabled={props.saving}
          onChange={(next) => {
            if (next === dataKind) return;
            const data = next === 'none' ? [] : seenData[next];
            if (data) save({ data });
          }}
        />
      ) : (
        <Item
          testID={`${props.testID}.data`}
          title={t('projects.deployments.settingsSections.previewsData')}
          detail={dataOptions.find((option) => option.id === dataKind)?.label}
          mode="info"
        />
      )}
      {template.forkPreviews === 'off' ? (
        <Item testID={`${props.testID}.forks`} title={t('projects.deployments.settingsSections.previewsForks')} mode="info" />
      ) : null}
    </>
  );
}

/**
 * No template yet (J6 entry): a repository-backed Environment turns previews on from its Project repository and its
 * own runtime link, saved once through `environments.update` (patch.previewTemplate). A stored definition says why
 * previews need a repository instead. The rest of the template is edited in the rows above once it exists.
 */
function PreviewSetupRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime | null;
  onSave: ((next: PreviewTemplate) => void) | null;
  saving: boolean;
  testID: string;
}>) {
  if (props.detail.content.definition.kind === 'stored') {
    return (
      <Item
        testID={`${props.testID}.needsRepository`}
        title={t('projects.deployments.settingsSections.previewsNeedRepository')}
        subtitle={t('projects.deployments.settingsSections.previewsNeedRepositoryBody')}
        mode="info"
      />
    );
  }
  const runtimeTargetLinkId = props.detail.environment.runtimeTargetLinkId;
  // Without a manager's save path or a runtime link there is nothing to turn on; the preview list says there are none.
  if (!props.onSave || !props.lifetime || !runtimeTargetLinkId) return null;
  return <PreviewTurnOnRow {...props} lifetime={props.lifetime} onSave={props.onSave} runtimeTargetLinkId={runtimeTargetLinkId} />;
}

function PreviewTurnOnRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  onSave: (next: PreviewTemplate) => void;
  saving: boolean;
  runtimeTargetLinkId: string;
  testID: string;
}>) {
  const project = useProjectSource(props.lifetime, props.detail.environment.projectSourceId);
  const repository = readProjectRepositoryIdentityV1({ source: project.source?.source ?? null });
  if (!repository) {
    return project.status === 'loading' ? null : (
      <Item testID={`${props.testID}.noRepository`}
        title={t('projects.deployments.settingsSections.previewsNoRepository')} mode="info" />
    );
  }
  return (
    <Item
      testID={`${props.testID}.setup`}
      title={t('projects.deployments.settingsSections.previewsTitle')}
      subtitle={t('projects.deployments.settingsSections.previewsSetUpOff')}
      rightElement={
        <Switch value={false} disabled={props.saving} onValueChange={(enabled) => {
          if (!enabled) return;
          props.onSave({ v: 1, enabled: true, forkPreviews: 'off', repository, runtimeTargetLinkId: props.runtimeTargetLinkId,
            domain: null, bindingBlueprints: [], data: [] });
        }} />
      }
    />
  );
}

/** A preview Environment names the pull request it serves and the template it was made from. */
function PreviewOfRow(props: SectionProps) {
  const { environment } = props.detail;
  const template = environment.previewTemplateEnvironmentId
    ? props.environmentTitle(environment.previewTemplateEnvironmentId)
    : null;
  return (
    <Item
      testID={`${props.testID}.of`}
      title={environment.previewPullRequestId
        ? t('projects.deployments.previewOf', { pullRequest: environment.previewPullRequestId })
        : t('projects.deployments.sectionPreviews')}
      subtitle={template
        ? t('projects.deployments.previewMadeFrom', { name: template })
        : t('projects.deployments.previewMadeFromTemplate')}
      mode="info"
    />
  );
}

/**
 * The previews made from this Environment (P44's exact template children), one page at a time: each says its
 * pull request by its name, the latest attempt's trouble or where it runs, and how long ago it changed — the
 * same row parts as the Environments rail. Paging moves only when the person asks.
 */
function TemplatePreviewRows(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    demand: DeploymentReadDemandV1;
    environmentId: string;
    testID: string;
  }>,
) {
  // The read keys its lease by the template id, so an inline query keeps the same page.
  const previews = useDeploymentEnvironmentPreviews(props.lifetime, props.demand, {
    previewTemplateEnvironmentId: props.environmentId,
  });
  const rows = useDeploymentEnvironmentRowParts(previews.result.items, props.testID);
  return (
    <>
      {rows.map((row) => (
        <Item
          key={row.environmentId}
          testID={`${props.testID}.${row.environmentId}`}
          title={row.title}
          subtitle={row.subtitle}
          subtitleLeading={row.subtitleLeading}
          detail={row.detail}
          mode="info"
        />
      ))}
      <DeploymentTabState
        result={previews.result}
        testID={props.testID}
        errorTitle={t('projects.deployments.previewsErrorTitle')}
        emptyTitle={t('projects.deployments.previewsEmpty')}
      />
      {previews.hasPreviousPage || previews.hasNextPage ? (
        <View style={styles.paging}>
          {previews.hasPreviousPage ? (
            <SectionActionButton
              testID={`${props.testID}.previous`}
              title={t('projects.deployments.pagePrevious')}
              icon="caret-left"
              onPress={previews.previousPage}
            />
          ) : null}
          {previews.hasNextPage ? (
            <SectionActionButton
              testID={`${props.testID}.next`}
              title={t('projects.deployments.pageNext')}
              icon="caret-right"
              onPress={previews.nextPage}
            />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
}));

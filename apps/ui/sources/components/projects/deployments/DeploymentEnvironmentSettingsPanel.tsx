import { DeploymentMigrationSettings } from './DeploymentMigrationSettings';
import { DeploymentRegistryCredentials } from './DeploymentRegistryCredentials';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
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
import type { DeploymentBackupConfigureResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol/v1';
import { readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSettingReveal } from '@/components/settings/shell/SettingRow';
import { NewAccountTriggerPopover } from '@/components/workflows/triggers/AccountTriggersSection';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { guidedStarterEventSeed } from '@/components/workflows/triggers/guidedAutomation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import type { DeploymentRetainedBackup } from './deploymentRestore';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { DeploymentTabState } from './DeploymentTabState';
import { DeploymentPrivateServiceExports } from './DeploymentPrivateServiceExports';
import { DeploymentFleetIngress } from './DeploymentFleetIngress';
import { MoveDefinitionToRepository } from './MoveDefinitionToRepository';
import { StoredDefinitionEditor, type StoredDefinitionDocument } from './StoredDefinitionEditor';
import {
  DeploymentBackupControls,
  DeploymentBackupDestinationRow,
  DeploymentBackupRetentionRows,
  DeploymentBackupSetup,
  DeploymentBackupConfigurationResult,
  DeploymentBackupCredentialRows,
  DeploymentBackupScheduleRow,
  deploymentBackupAttention,
  useDeploymentBackupFacts,
} from './DeploymentBackupControls';
import { deploymentDataTargetOperands } from '@happier-dev/deployments';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { createDeploymentActions } from './deploymentActions';
import { DeployOutcomeBanner, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { PreviewTemplateRows } from './DeploymentPreviewTemplateRows';
import { DeploymentPreviewVariables } from './DeploymentPreviewVariables';
import { useDeploymentEnvironmentPreviews } from './useDeploymentProject';
import {
  useDeploymentEnvironmentBackups,
  useDeploymentEnvironmentChecks,
} from './useDeploymentReads';

const noop = () => {};

/** What a manager can change from Settings and Permissions, through the Action owner. */
export type DeploymentEnvironmentEditing = Readonly<{
  actions: Pick<ReturnType<typeof createDeploymentActions>, 'setController' | 'updateEnvironment'>
    & Partial<Pick<ReturnType<typeof createDeploymentActions>, 'inspectPlatformTarget' | 'moveToRepository' | 'prepareConfigurationDefaults' | 'preparePreviewForkPolicy' | 'setBindings'>>;
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
      phone?: boolean;
      controller: DeploymentReadControllerV1;
      demand: DeploymentReadDemandV1;
      machineName: (machineId: string) => string;
      /** Names the template a preview was made from, from the page's Environment list. */
      environmentTitle: (environmentId: string) => string | null;
      /** A section another page or tab linked to (Permissions → Controller, Open backups); it scrolls into view when the tab opens. */
      focusSection?: DeploymentEnvironmentSettingsSectionV1 | null;
      /** Opens the irreversible Unlink review for a target; null where this viewer cannot remove it. */
      onUnlink?: ((targetLinkId: string) => void) | null;
      /** Opens the Link a machine sheet; null where this viewer cannot link one. */
      onLink?: (() => void) | null;
      /** Reuses Link a machine to replace a first placement before anything has deployed. */
      onChangeMachine?: (() => void) | null;
      onManageServers?: (() => void) | null;
      /** Opens the Add platform target sheet; null where this viewer cannot link one. */
      onAddPlatform?: (() => void) | null;
      /** The backup the serving deploy kept before its migration, with the restore sheet that replaces data with it. */
      retainedBackup?: DeploymentRetainedBackup | null;
      onRestore?: (() => void) | null;
      /** The captured Home/Account the template's preview list reads under; absent while it is not current. */
      lifetime?: ServerAccountScopeLifetime | null;
      /** The Action owner's manager edits; absent where this viewer cannot change settings. */
      editing?: DeploymentEnvironmentEditing | null;
      previewBindings?: React.ComponentProps<typeof DeploymentPreviewVariables>['draft'];
      definitionDocument: StoredDefinitionDocument;
      review?: DeploymentReviewHandle;
      /** Opens a Machine's Services page (health checks); absent where no Home is known. */
      onOpenMachineServices?: ((machineId: string) => void) | null;
      /** Opens Add a database for an Environment with nothing to back up yet. */
      onAddDatabase?: (() => void) | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const editing = props.detail.environment.capabilities.role === 'manager' ? props.editing ?? null : null;
    const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
    // One reveal for whichever section the address names; only that section's host takes its ref.
    const sectionReveal = useSettingReveal(props.focusSection != null, 0);
    const revealHost = (id: DeploymentEnvironmentSettingsSectionV1) => props.focusSection === id ? sectionReveal.hostRef : undefined;
    const { detail, machineName } = props;
    const previewEnrollmentEnabled = detail.environment.purpose !== 'preview' && detail.content.previewTemplate?.enabled === true;
    const previewEnrollment = useWorkflowTriggerSets(previewEnrollmentEnabled && props.lifetime
      ? { scope: 'account_inline' } : null, props.lifetime ?? null);
    const enrolledPreview = previewEnrollment.sets.find(set => {
      const target = set.context?.deploymentPreview;
      return target?.environmentId === detail.environment.id
        && areServerProfileIdentifiersEquivalent(target.serverId, detail.environment.serverId);
    });
    const previewEnrollmentUnavailable = previewEnrollmentEnabled && previewEnrollment.status !== 'loading'
      && (previewEnrollment.status === 'failed' || !enrolledPreview?.enabled || enrolledPreview.health === 'source_unavailable');
    const runtimeMachines = detail.runtimeTargetLink?.machines ?? [];
    const runtimeLinkId = detail.runtimeTargetLink?.id ?? null;
    const platformSource = detail.runtimeTargetLink?.source.kind === 'plugin' ? detail.runtimeTargetLink.source : null;
    // A row's subtitle is styled text only as a string; the descriptor's own name, or its kind until that loads.
    const platformTitle = useDeploymentPlatformTargetTitles(props.lifetime ?? null, platformSource !== null);
    const platformName = platformSource ? platformTitle(platformSource) ?? detail.runtimeTargetLink?.targetKind : undefined;
    const { onUnlink, onLink, onChangeMachine, onAddPlatform } = props;
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
    // Each change's outcome shows inside the section that pressed it, as Backups places its retention outcome;
    // the Compose editor sits right under the page lead, so its outcome stays there.
    const changeOutcome = (at: DeploymentEnvironmentSettingsSectionV1 | null) => change.outcome && editing && change.outcomeAt === at ? (
      <DeployOutcomeBanner
        controller={change.banner}
        machine={machineName(detail.environment.controllerMachineId)}
        copy="setting"
      />
    ) : null;
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
        {changeOutcome(null)}
        <View ref={revealHost('servers-build')} collapsable={false}>
        <ItemGroup
          testID={section('servers-build')}
          title={t('projects.deployments.sectionServersBuild')}
          description={t('projects.deployments.sectionServersBuildDescription')}
          action={onChangeMachine ? (
            <SectionActionButton
              testID={`${section('servers-build')}.change`}
              title={t('common.change')}
              icon="arrows-left-right"
              onPress={onChangeMachine}
            />
          ) : props.onManageServers ? (
            <SectionActionButton testID={`${section('servers-build')}.manage`}
              title={t('projects.deployments.overviewStatus.manage')} onPress={props.onManageServers} />
          ) : onAddPlatform && !runtimeLinkId ? (
            <SectionActionButton
              testID={`${section('servers-build')}.addPlatform`}
              title={t('projects.deployments.platformLink.add')}
              icon="cloud"
              onPress={onAddPlatform}
            />
          ) : undefined}
        >
          {changeOutcome('servers-build')}
          {onChangeMachine && props.onManageServers ? <Item
            testID={`${section('servers-build')}.manage`} title={t('projects.deployments.settingsSections.fleet.title')}
            onPress={props.onManageServers} /> : null}
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
            <SessionMachineField
              testID={`${section('servers-build')}.buildsOn`}
              serverId={editing.serverId}
              icon={machineIcon}
              title={t('projects.deployments.buildsOn')}
              machineId={buildMachineId ?? null}
              placeholder={t('projects.deployments.buildsOnTarget')}
              machineName={buildMachineId ? machineName(buildMachineId) : null}
              awayMachinesChoosable
              disabled={change.running}
              onSelectMachine={(machine) => {
                void change.press(() => editing.actions.updateEnvironment(detail.environment, { buildMachineId: machine.id }), 'servers-build');
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
          {detail.runtimeTargetLink?.targetKind === 'ownServer' ? (
            <Item testID={`${section('servers-build')}.images`}
              title={t('projects.deployments.receipt.imagesTitle')}
              subtitle={t('projects.deployments.settingsSections.imageDistribution')}
              mode="info" />
          ) : null}
          <DeploymentFleetIngress detail={detail} editing={editing} machineName={machineName} />
        </ItemGroup>
        </View>

        {/* Where it runs leads (lab envSet); what it runs, the definition, follows. */}
        {detail.content.definition.kind === 'stored' ? <StoredDefinitionEditor environment={detail.environment}
          definition={detail.content.definition} document={props.definitionDocument} editing={editing} change={change} /> : null}
        {editing ? <MoveDefinitionToRepository detail={detail} lifetime={props.lifetime ?? null}
          move={editing.actions.moveToRepository ?? null} review={editing.review} onChanged={editing.onChanged} machineName={machineName} /> : null}
        <DeploymentPrivateServiceExports detail={detail} editing={editing} />

        <View ref={revealHost('controller')} collapsable={false}>
        <ItemGroup
          testID={section('controller')}
          title={t('projects.deployments.sectionController')}
          description={t('projects.deployments.sectionControllerDescription')}
        >
          {changeOutcome('controller')}
          {editing ? (
            <SessionMachineField
              testID={`${section('controller')}.machine`}
              serverId={editing.serverId}
              icon={machineIcon}
              title={t('projects.deployments.controllerRow')}
              machineId={detail.environment.controllerMachineId}
              machineName={machineName(detail.environment.controllerMachineId)}
              awayMachinesChoosable
              disabled={change.running}
              onSelectMachine={(machine) => {
                void change.press(() => editing.actions.setController(detail.environment, machine.id), 'controller');
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
          {changeOutcome('rollout')}
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
                  void change.press(() => editing.actions.updateEnvironment(detail.environment, { ownServer: { rollout } }), 'rollout');
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
                        { ownServer: { autoRestorePreviousRelease } }), 'rollout');
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
                    { retainPreviousDeployments: count }), 'rollout');
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

        <DeploymentMigrationSettings detail={detail} editing={editing} machineName={machineName} />
        <DeploymentRegistryCredentials detail={detail} editing={editing} lifetime={props.lifetime ?? null} machineName={machineName} />

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
          <Item
            testID={`${section('checks-alerts')}.alerts`}
            title={t('projects.deployments.alertsRow')}
            {...(checkLifetime
              ? { showChevron: true, onPress: () => setOpeningCheckSetup(true) }
              : { mode: 'info' as const })}
          />
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
        <View ref={revealHost('backups')} collapsable={false}>
        <ItemGroup
          testID={section('backups')}
          title={t('projects.deployments.sectionBackups')}
          description={t('projects.deployments.sectionBackupsDescription')}
        >
          <BackupRows {...props} testID={section('backups')} />
        </ItemGroup>
        </View>
        {detail.environment.purpose === 'preview' || props.lifetime || detail.content.previewTemplate ? (
          <View ref={revealHost('previews')} collapsable={false}>
          <ItemGroup
            testID={section('previews')}
            title={t('projects.deployments.sectionPreviews')}
            description={t('projects.deployments.sectionPreviewsDescription')}
          >
            {changeOutcome('previews')}
            {/* The save landed; only new pull requests are affected, so the warning sits with the previews it concerns. */}
            {change.followup || previewEnrollmentUnavailable ? (
              <SurfaceStateCard testID="project-deployments.environment.settings.preview-enrollment" kind="warning" size="line"
                title={t('projects.deployments.settingsSections.previewsEnrollmentUnavailable')}
                reason={change.followup ? readDeploymentRefusalRecoveryV1(change.followup.errorCode)?.remedy : undefined}
                diagnosticCode={change.followup?.errorCode}
                action={previewEnrollment.status === 'failed'
                  ? { label: t('common.retry'), onPress: previewEnrollment.retry } : undefined} />
            ) : null}
            {detail.environment.purpose !== 'preview' ? (
              <PreviewTemplateRows
                detail={detail}
                controller={props.controller}
                demand={props.demand}
                machineName={machineName}
                onSave={editing ? (next) => {
                  void change.press(() => editing.actions.updateEnvironment(detail.environment, { previewTemplate: next }), 'previews');
                } : null}
                saving={change.running}
                inspect={editing?.actions.inspectPlatformTarget ?? null}
                prepareDefaults={editing?.actions.prepareConfigurationDefaults ?? null}
                prepareForkPolicy={editing?.actions.preparePreviewForkPolicy ?? null}
                onChooseMachine={props.onChangeMachine ?? props.onLink ?? null}
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
          </View>
        ) : null}
        {detail.environment.purpose !== 'preview' && detail.content.previewTemplate && props.lifetime && props.review && props.previewBindings ? (
          <DeploymentPreviewVariables detail={detail} lifetime={props.lifetime} draft={props.previewBindings}
            domainRead={{ controller: props.controller, demand: props.demand }}
            review={props.review}
            phone={props.phone === true} environmentName={props.environmentTitle}
            sealedOn={detail.runtimeTargetLink?.machines?.map(machineName).join(', ') ?? null} />
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
  /** Opens Add a database for an Environment with nothing to back up yet. */
  onAddDatabase?: (() => void) | null;
  testID: string;
}>;

/** Native deployed-service health; saved checks and alerts use the source editor above. */
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
    </>
  );
}

/**
 * Saved backup configuration, with explicit run and integrity verification Actions. Historical status is
 * not inferred from configuration or from a successful integrity check.
 */
function BackupRows(props: SectionProps) {
  const { theme } = useUnistyles();
  const backups = useDeploymentEnvironmentBackups(props.controller, props.detail.environment.id, props.demand);
  const backup = backups.result.items[0];
  const manager = props.detail.environment.capabilities.role === 'manager';
  const { lifetime } = props;
  const projectSourceId = props.detail.environment.projectSourceId;
  // The backup Actions run under the page's captured Home/Account; a viewer who cannot manage sees the facts only.
  const actions = React.useMemo(() => manager && lifetime && props.review
    ? createDeploymentActions(lifetime, projectSourceId) : null, [manager, lifetime, props.review, projectSourceId]);
  const editing = manager ? props.editing ?? null : null;
  const target = deploymentDataTargetOperands(props.detail);
  const deploymentId = props.detail.runtimeTargetLink?.activeDeploymentId;
  const configured = backup && !('notNeeded' in backup) ? backup : null;
  const factsInput = target && deploymentId && configured ? { ...target, deploymentId, configRevision: configured.configRevision } : null;
  const backupFacts = useDeploymentBackupFacts(actions, factsInput, true);
  const attention = deploymentBackupAttention(backupFacts.facts);
  const retentionChange = useDeploymentChangePress(editing?.review ?? null, noop);
  const [retentionResult, setRetentionResult] = React.useState<DeploymentBackupConfigureResultV1 | null>(null);
  const saveRetention = React.useMemo(() => editing && configured && actions
    ? async (retention: DeploymentBackupConfigurationV1['retention']) => {
      let configuredResult = false;
      await retentionChange.press(async () => {
        const result = await actions.configureBackup(props.detail.environment, { intent: 'save',
          configuration: { ...configured, retention } });
        setRetentionResult(result);
        configuredResult = result.kind === 'configured';
        if (configuredResult) editing.onChanged();
        return { ok: true };
      });
      return configuredResult;
    } : null, [actions, configured, editing, retentionChange.press, props.detail.environment]);
  const setup = editing && actions && lifetime ? <DeploymentBackupSetup
    detail={props.detail} serverId={editing.serverId} testID={props.testID} review={editing.review}
    onChanged={editing.onChanged} machineName={props.machineName} onAddDatabase={props.onAddDatabase}
    lifetime={lifetime} actions={{ configureBackup: actions.configureBackup,
      addBackupSchedule: actions.addBackupSchedule,
      prepareConfigurationDefaults: editing.actions.prepareConfigurationDefaults ?? actions.prepareConfigurationDefaults }} /> : null;
  if (!backup && backups.result.status === 'empty' && setup) return setup;
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
  if ('notNeeded' in backup) return <>
    <Item testID={`${props.testID}.notNeeded`} title={t('projects.deployments.backupNotNeededTitle')}
      subtitle={t('projects.deployments.backupNotNeededBody', { name: props.detail.content.name })} mode="info" />
    {setup}
  </>;

  return (
    <>
      <DeploymentBackupDestinationRow detail={props.detail} configuration={backup} actions={actions}
        lifetime={props.lifetime ?? undefined} testID={props.testID} />
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
      <DeploymentBackupConfigurationResult result={retentionResult}
        machine={props.machineName(props.detail.environment.controllerMachineId)} testID={`${props.testID}.retention`} />
      {retentionChange.outcome && editing ? (
        <DeployOutcomeBanner
          controller={retentionChange.banner}
          machine={props.machineName(props.detail.environment.controllerMachineId)}
          copy="setting"
        />
      ) : null}
      {/* The owner-approved missed/failed notice: an overdue unstarted run first, then a latest backup that failed. */}
      <Item
        testID={`${props.testID}.status`}
        title={t('projects.deployments.databaseLastBackup')}
        detail={backupFacts.facts?.status === 'ready'
          ? attention.lastGood ? formatAsOfTime(attention.lastGood.completedAt) : t('projects.deployments.databaseNoBackupYet')
          : undefined}
        subtitle={attention.missed
          ? `${t('projects.deployments.databaseStatusMissed')} · ${t('projects.deployments.databaseMissedBody', { time: formatAsOfTime(attention.missed.dueAt) })}`
          : attention.failed
            ? `${t('projects.deployments.databaseStatusFailed')} · ${formatAsOfTime(attention.failed.completedAt)}`
            : backupFacts.facts === null ? t('projects.deployments.backupStatusUnavailable') : undefined}
        subtitleLeading={attention.missed || attention.failed ? (
          <StatusDot size={6} color={attention.missed ? theme.colors.state.warning.foreground : theme.colors.state.danger.foreground} />
        ) : undefined}
        mode="info"
      />
      {props.lifetime && props.review && props.detail.environment.capabilities.role === 'manager' ? (
        <DeploymentBackupControls
          key={`${props.lifetime.scope.serverId}:${props.lifetime.scope.accountId}:${props.detail.environment.id}:${props.detail.environment.revision}:${props.detail.runtimeTargetLink?.activeDeploymentId}:${backup.configRevision}`}
          detail={props.detail} configuration={backup} lifetime={props.lifetime}
          review={props.review}
          onBackupCompleted={backupFacts.reload}
          machineName={props.machineName} testID={props.testID}
        />
      ) : null}
      {props.onRestore ? (
        <Item
          testID={`${props.testID}.restore`}
          title={t('projects.deployments.restoreEntry')}
          subtitle={!props.retainedBackup ? t('projects.deployments.settingsSections.restoreExtended.uploadBody') : props.retainedBackup.versionLabel
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

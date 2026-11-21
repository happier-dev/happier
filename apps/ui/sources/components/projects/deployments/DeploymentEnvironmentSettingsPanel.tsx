import type { VariableReferenceEnvironments } from './DeploymentVariablesPanel';
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
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
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
import { REVEAL_DELAY_MS, useSettingReveal } from '@/components/settings/shell/SettingRow';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { subjectStarterEventSeed } from '@/components/workflows/triggers/subjectTriggerStarters';
import { AddCheckSetup } from './AddCheckSetup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import { databaseEngineTitle } from './databasePresentation';
import type { DeploymentRetainedBackup } from './deploymentRestore';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { DeploymentTabState } from './DeploymentTabState';
import { DeploymentPrivateServiceExports } from './DeploymentPrivateServiceExports';
import { DeploymentFleetIngress } from './DeploymentFleetIngress';
import { MoveDefinitionToRepository } from './MoveDefinitionToRepository';
import { StoredDefinitionEditor, type StoredDefinitionDocument } from './StoredDefinitionEditor';
import {
  DeploymentBackupControls,
  DeploymentBackupSectionActions,
  useDeploymentBackupOperations,
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
import { deploymentPreviewAvailability } from './deploymentPresentation';
import { DeploymentPreviewVariables } from './DeploymentPreviewVariables';
import { useDeploymentEnvironmentPreviews } from './useDeploymentProject';
import {
  useDeploymentEnvironmentBackups,
  useDeploymentEnvironmentChecks,
} from './useDeploymentReads';

const noop = () => {};
const NO_MORE_BACKUP_ACTIONS: readonly never[] = Object.freeze([]);

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
      /** The Project's Environments, which Private sharing names as the places that can point at a shared service. */
      referenceEnvironments?: VariableReferenceEnvironments;
      /** The Action owner's manager edits; absent where this viewer cannot change settings. */
      editing?: DeploymentEnvironmentEditing | null;
      previewAvailability?: ReturnType<typeof deploymentPreviewAvailability>;
      previewBindings?: React.ComponentProps<typeof DeploymentPreviewVariables>['draft'];
      definitionDocument: StoredDefinitionDocument;
      review?: DeploymentReviewHandle;
      /** Opens a Machine's Services page (health checks); absent where no Home is known. */
      onOpenMachineServices?: ((machineId: string) => void) | null;
      /** Opens Add a database for an Environment with nothing to back up yet. */
      onAddDatabase?: (() => void) | null;
      /** Pushes one database's page (P9), where its backup operations live; absent where no page can open. */
      onOpenDatabase?: ((database: string) => void) | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const editing = props.detail.environment.capabilities.role === 'manager' ? props.editing ?? null : null;
    const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
    // One reveal for whichever section the address names; only that section's host takes its ref.
    // Keyed by the section, so a second link to another section while Settings is open reveals that one too.
    const sectionReveal = useSettingReveal(props.focusSection ?? null, REVEAL_DELAY_MS);
    const revealHost = (id: DeploymentEnvironmentSettingsSectionV1) => props.focusSection === id ? sectionReveal.hostRef : undefined;
    const { detail, machineName } = props;
    const previewAvailability = props.previewAvailability ?? deploymentPreviewAvailability(detail);
    const previewEnrollmentEnabled = previewAvailability === 'on';
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
        {/* The kept order (dEnvSettings KEEP): the stored definition and Move to repository, then where it runs. */}
        {/* The stored Compose editor, then Move to repository (pfc-redesign r4 dSettings KEEP items 2-3, owner-approved 11-13). */}
        {detail.content.definition.kind === 'stored' ? <StoredDefinitionEditor environment={detail.environment}
          definition={detail.content.definition} document={props.definitionDocument} editing={editing} change={change} /> : null}
        {editing ? <MoveDefinitionToRepository detail={detail}
          lifetime={props.lifetime ?? null} move={editing.actions.moveToRepository ?? null} review={editing.review}
          onChanged={editing.onChanged} machineName={machineName} /> : null}
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

        {detail.runtimeTargetLink?.targetKind === 'ownServer' ? <>
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
        </> : null}

        {/* dSettings KEEP order: private sharing follows the registry credentials. */}
        <View ref={revealHost('sharing')} collapsable={false}>
          <DeploymentPrivateServiceExports detail={detail} editing={editing} environments={props.referenceEnvironments}
            lifetime={props.lifetime ?? null} />
        </View>

        <ItemGroup
          testID={section('checks-alerts')}
          title={t('projects.deployments.sectionChecks')}
          description={t('projects.deployments.sectionChecksDescription')}
          action={checkLifetime ? (
            <SectionActionButton
              testID={`${section('checks-alerts')}.add`}
              title={t('projects.deployments.settingsSections.addCheck')}
              icon="plus"
              expanded={openingCheckSetup}
              onPress={() => setOpeningCheckSetup(true)}
            />
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
          {openingCheckSetup && checkLifetime ? (
            // One surface: the check's own form opens on the controller; its waits and refusals stand in this section (R10-D1).
            <AddCheckSetup
              testID={`${section('checks-alerts')}.setup`}
              onClose={() => setOpeningCheckSetup(false)}
              lifetime={checkLifetime}
              seed={subjectStarterEventSeed('addCheck', {
                subject: { kind: 'environment', environmentId: detail.environment.id,
                  machineId: detail.environment.controllerMachineId },
                controllerMachineId: detail.environment.controllerMachineId,
              })}
            />
          ) : null}
        </ItemGroup>
        {/* Native backups copy a Machine's volumes and dumps; a platform Environment's data is its provider's (D14). */}
        {platformSource === null ? <View ref={revealHost('backups')} collapsable={false}>
          <BackupRows {...props} testID={section('backups')} />
        </View> : null}
        {previewAvailability === 'preview' || previewAvailability === 'needsRepository' || props.lifetime || detail.content.previewTemplate ? (
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
            {previewAvailability !== 'preview' ? (
              <PreviewTemplateRows
                detail={detail}
                previewAvailability={previewAvailability}
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
            {previewAvailability === 'preview' ? (
              <PreviewOfRow {...props} testID={section('previews')} />
            ) : previewAvailability !== 'needsRepository' && props.lifetime && detail.content.previewTemplate ? (
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
        {(previewAvailability === 'on' || previewAvailability === 'off')
          && detail.content.previewTemplate && props.lifetime && props.review && props.previewBindings ? (
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
  onOpenDatabase?: ((database: string) => void) | null;
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
  // Without a Database page these operations have no other home; one controller serves the action and the list.
  const backupOperations = useDeploymentBackupOperations({ detail: props.detail, configuration: configured,
    actions: manager && props.review ? actions : null, review: props.review ?? null, onSettled: backupFacts.reload });
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
  // Owner 2026-11-17: where a Database page exists it owns the backup operations (back up, restore, drill, saved
  // copies) and history (P9); this section keeps the configuration and links there. Without one, the operations have
  // no other home and stay here.
  const databases = props.onOpenDatabase ? props.detail.content.template?.data ?? [] : [];
  const operationsHere = databases.length === 0;
  // Read top-down: what is copied, where, when and for how long, then (here only) the copies and what you do with them.
  const configSection = (children: React.ReactNode, restore = false) => (
    <ItemGroup
      testID={props.testID}
      title={t('projects.deployments.sectionBackups')}
      description={t('projects.deployments.sectionBackupsDescription')}
      action={restore && operationsHere && (props.onRestore || backupOperations.run) ? (
        <DeploymentBackupSectionActions operations={backupOperations} onRestore={props.onRestore ?? null}
          more={NO_MORE_BACKUP_ACTIONS} testID={`${props.testID}.operations`} />
      ) : undefined}
    >
      {children}
    </ItemGroup>
  );
  if (!backup && backups.result.status === 'empty' && setup) return configSection(setup);
  if (!backup || backups.result.status !== 'ready') {
    return configSection(
      <DeploymentTabState
        result={backups.result}
        testID={props.testID}
        errorTitle={t('projects.deployments.backupsErrorTitle')}
        emptyTitle={t('projects.deployments.settingsSections.backupNotSetUpBody')}
      />,
    );
  }
  if ('notNeeded' in backup) return configSection(<>
    <Item testID={`${props.testID}.notNeeded`} title={t('projects.deployments.backupNotNeededTitle')}
      subtitle={t('projects.deployments.backupNotNeededBody', { name: props.detail.content.name })} mode="info" />
    {setup}
  </>);

  return configSection(<>
      {/* What is copied, then where it goes, when, and how long copies stay. */}
      <Item
        testID={`${props.testID}.sources`}
        title={t('projects.deployments.backupSources')}
        subtitle={backup.sources.map((source) => source.kind === 'dump'
          ? t('projects.deployments.backupSourceDump', { service: source.service })
          : t('projects.deployments.backupSourceVolume', { service: source.service, volume: source.volume })).join(', ')}
        mode="info"
      />
      <DeploymentBackupDestinationRow detail={props.detail} configuration={backup} actions={actions}
        lifetime={props.lifetime ?? undefined} testID={props.testID} />
      <DeploymentBackupCredentialRows
        detail={props.detail} configuration={backup} lifetime={actions ? props.lifetime ?? null : null}
        actions={actions} review={props.review ?? null} onChanged={editing?.onChanged ?? noop}
        machineName={props.machineName} testID={props.testID}
      />
      <DeploymentBackupScheduleRow detail={props.detail} configuration={backup} actions={actions} testID={props.testID}
        drill={operationsHere} />
      <DeploymentBackupRetentionRows
        key={`${backup.configRevision}:${props.detail.environment.revision}`}
        detail={props.detail} configuration={backup} label={retentionLabel(backup.retention)}
        onSave={saveRetention} actions={actions} review={props.review ?? null}
        machineName={props.machineName} prune={operationsHere} testID={props.testID}
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
      {databases.map(data => (
        <Item key={data.service} testID={`${props.testID}.database.${data.service}`} title={databaseEngineTitle(data)}
          subtitle={t('projects.deployments.databaseBackupsDescription')} onPress={() => props.onOpenDatabase?.(data.service)} />
      ))}
      {/* The owner-approved missed/failed notice: an overdue unstarted run first, then a latest backup that failed. */}
      {operationsHere ? <Item
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
      /> : null}
      {operationsHere && props.lifetime && props.review && props.detail.environment.capabilities.role === 'manager' ? (
        <DeploymentBackupControls operations={backupOperations} facts={backupFacts.facts}
          machineName={props.machineName} testID={props.testID} />
      ) : null}
      {/* The copy the serving deploy kept before its migration is one of the saved copies; Restore above opens it. */}
      {operationsHere && props.onRestore && props.retainedBackup ? (
        <Item
          testID={`${props.testID}.restore`}
          title={props.retainedBackup.versionLabel
            ? t('projects.deployments.restoreBackupBefore', { version: props.retainedBackup.versionLabel,
              time: formatAsOfTime(props.retainedBackup.takenAtMs) })
            : t('projects.deployments.restoreBackupTaken', { time: formatAsOfTime(props.retainedBackup.takenAtMs) })}
          mode="info"
        />
      ) : null}
    </>, true);
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
  const rows = useDeploymentEnvironmentRowParts(previews.result.items, props.testID, props.lifetime);
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

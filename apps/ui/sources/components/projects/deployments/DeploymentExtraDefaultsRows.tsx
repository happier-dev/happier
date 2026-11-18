import * as React from 'react';
import type { DeploymentCreationDefaultsV1, DeploymentCreationDefaultSourceV1,
  ResolvedDeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { DeploymentCreationDefaultsV1Schema } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { HealthCheckAlertChannelV1Schema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ScheduleRows } from '@/components/workflows/triggers/TriggerPopover';
import { buildTriggerDefinition, createDefaultWhen, readScheduleWhen } from '@/components/workflows/triggers/sessionTriggerForm';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { presentNotificationDestinationSelection } from '@/components/plugins/actions/presentNotificationDestinationSelection';
import { t } from '@/text';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { deploymentBackupKeepFields, deploymentBackupKeepLabels, deploymentBackupRetentionDraftFrom,
  retentionFromDraft } from './deploymentBackupRetention';

const destinationSections = Object.freeze(['familiesById.backupDestinations']);
type Preferences = DeploymentCreationDefaultsV1;
type Source = DeploymentCreationDefaultSourceV1 | undefined;

/**
 * The creation defaults a person edits on the Account and Project pages, in three sections (Deploys, Previews,
 * Backups). Every row shows the value a new Environment would take: a value that follows a default reads muted (the
 * field's placeholder, the segmented control's inherited thumb), one the person set reads normally, and only a default
 * from the Account or Project says where it came from. One reset at the foot clears every value set here
 * (UI refinements 2026-11-18); a row's own menu keeps its default as a choice.
 */
export function DeploymentDefaultsEditorSections(props: Readonly<{
  serverId: string;
  preferences: Preferences;
  resolved: ResolvedDeploymentCreationDefaultsV1;
  /** The menu choice that clears one Machine or destination ("Use Account default"). */
  inheritLabel: string;
  /** The foot's one reset ("Reset to Happier's defaults"). */
  resetLabel: string;
  disabled: boolean;
  onChange: React.Dispatch<React.SetStateAction<Preferences>>;
  sourceLabel: (source: DeploymentCreationDefaultSourceV1 | undefined) => string | undefined;
}>) {
  const [destinationOpen, setDestinationOpen] = React.useState(false);
  const [selectingAlert, setSelectingAlert] = React.useState(false);
  const [alertUnavailable, setAlertUnavailable] = React.useState(false);
  const accountBindings = useServerCredentialAccountScopeBindings([props.serverId]);
  const accountLifetime = accountBindings.get(resolveServerProfileScopeIdForIdentifier(props.serverId));
  const projection = usePluginUiProjectionCurrentness({ serverId: props.serverId,
    machineId: props.resolved.values.controllerMachineId ?? null, enabled: destinationOpen,
    sections: destinationSections });
  const localize = usePluginLocalizedTextResolver({ projection: projection.pluginUiProjection });
  const { preferences, resolved } = props;
  // A Machine a default names reads by its name; with none, the Machine the Environment runs on.
  const target = t('projects.deployments.buildsOnTarget');
  const builder = useServerScopedMachineLabel(props.serverId, resolved.values.buildMachineId ?? null);
  const controller = useServerScopedMachineLabel(props.serverId, resolved.values.controllerMachineId ?? null);
  const previewMachine = useServerScopedMachineLabel(props.serverId, resolved.values.previewMachineId ?? null);
  // Only a default from the Account or Project names its origin; Happier's own and the person's own values say nothing.
  const origin = (source: Source) => source === 'account' || source === 'project' ? props.sourceLabel(source) : undefined;
  const inherited = (key: keyof Preferences) => preferences[key] === undefined ? 'inherited' as const : 'set' as const;
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    if (props.disabled) return;
    props.onChange(current => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const selectAlert = async (index?: number) => {
    if (props.disabled || selectingAlert) return;
    setSelectingAlert(true);
    setAlertUnavailable(false);
    try {
      const selected = await presentNotificationDestinationSelection({
        host: { serverId: props.serverId,
          machineId: resolved.values.controllerMachineId
            ?? (accountLifetime ? resolveUiAccountActionFallbackMachineId(accountLifetime.scope) : null),
          accountLifetime },
        ...(index === undefined ? {} : { channelId: preferences.alertChannels?.[index]?.channelId }),
        isCurrent: () => accountLifetime?.isCurrent() === true,
      });
      if (selected.kind === 'notificationDestination') {
        const authoredChannel = HealthCheckAlertChannelV1Schema.parse(selected.channel);
        change('alertChannels', index === undefined
          ? [...(preferences.alertChannels ?? []), authoredChannel]
          : preferences.alertChannels?.map((channel, position) => position === index ? authoredChannel : channel));
      }
      else if (selected.kind === 'unavailable') setAlertUnavailable(true);
    } catch { setAlertUnavailable(true); }
    finally { setSelectingAlert(false); }
  };
  const destinations = Object.values(projection.pluginUiProjection?.backupDestinationsById ?? {});
  const destinationId = preferences.backupDestination === undefined ? 'inherit'
    : preferences.backupDestination === null ? 'off' : buildQualifiedPluginContributionKey(preferences.backupDestination);
  const destinationItems: DropdownMenuItem[] = [
    { id: 'inherit', title: props.inheritLabel },
    { id: 'off', title: t('projects.deployments.settingsSections.previewsDataNone') },
    ...destinations.map(entry => ({ id: buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: entry.definition.id }),
      title: localize(entry.pluginId, entry.definition.title), disabled: !projection.interactionEnabled })),
  ];
  if (destinationOpen && (projection.phase !== 'current' || destinations.length === 0)) {
    destinationItems.push({ id: 'destination-status', disabled: true,
      title: projection.phase === 'establishing' ? t('projects.deployments.loading')
        : projection.phase === 'current' ? t('projects.deployments.settingsSections.setupNoDestination')
          : t('projects.deployments.settingsSections.setupDestinationsUnavailable') });
  }
  if (!destinationItems.some(entry => entry.id === destinationId) && preferences.backupDestination) {
    destinationItems.push({ id: destinationId, title: preferences.backupDestination.localId,
      subtitle: t('projects.deployments.settingsSections.setupDestinationsUnavailable'), disabled: true });
  }
  // What the destination row says while it follows a default: the inherited destination's name, else None, else that
  // setup chooses it (Happier has no destination of its own).
  const inheritedDestination = resolved.values.backupDestination;
  const inheritedEntry = inheritedDestination ? destinations.find(entry => entry.pluginId === inheritedDestination.pluginId
    && entry.definition.id === inheritedDestination.localId) : undefined;
  const inheritedDestinationName = inheritedDestination === null ? t('projects.deployments.settingsSections.previewsDataNone')
    : inheritedEntry ? localize(inheritedEntry.pluginId, inheritedEntry.definition.title)
    : inheritedDestination ? inheritedDestination.localId : props.sourceLabel('builtin') ?? null;
  const retention = preferences.backupRetention ?? resolved.values.backupRetention ?? { kind: 'keepEverything' as const };
  const retentionDraft = deploymentBackupRetentionDraftFrom(retention);
  const schedule = preferences.backupSchedule !== undefined ? preferences.backupSchedule : resolved.values.backupSchedule;
  const alertChannels = preferences.alertChannels ?? resolved.values.alertChannels ?? [];
  const previewDatabase = preferences.previewDatabase ?? resolved.values.previewDatabase ?? null;
  const changed = Object.keys(preferences).length > 0;
  return <>
    <ItemGroup testID="deployment-defaults.deploys" title={t('projects.deployments.defaultsEditor.sectionDeploys')}>
      <SessionMachineField testID="deployment-defaults.builder" serverId={props.serverId}
        title={t('projects.deployments.buildsOn')} machineId={preferences.buildMachineId ?? null}
        machineName={resolved.values.buildMachineId ?? null}
        subtitle={origin(resolved.sources.buildMachineId)}
        defaultChoice={{ title: props.inheritLabel, value: builder ?? resolved.values.buildMachineId ?? target,
          onChoose: () => change('buildMachineId', undefined) }}
        awayMachinesChoosable disabled={props.disabled} onSelectMachine={machine => change('buildMachineId', machine.id)} />
      <SessionMachineField testID="deployment-defaults.controller" serverId={props.serverId}
        title={t('projects.deployments.controllerRow')} machineId={preferences.controllerMachineId ?? null}
        machineName={resolved.values.controllerMachineId ?? null}
        subtitle={origin(resolved.sources.controllerMachineId)}
        defaultChoice={{ title: props.inheritLabel, value: controller ?? resolved.values.controllerMachineId ?? target,
          onChoose: () => change('controllerMachineId', undefined) }}
        awayMachinesChoosable disabled={props.disabled} onSelectMachine={machine => change('controllerMachineId', machine.id)} />
      <FieldValueItem testID="deployment-defaults.retention" fieldTestID="deployment-defaults.retention.input"
        title={t('projects.deployments.defaultsEditor.retention')}
        subtitle={origin(resolved.sources.retainPreviousDeployments)}
        kind="integer" allowEmpty disabled={props.disabled}
        value={preferences.retainPreviousDeployments?.toString() ?? ''}
        placeholder={String(resolved.values.retainPreviousDeployments)}
        stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }}
        compactStepper
        onCommit={draft => {
          if (props.disabled) return preferences.retainPreviousDeployments?.toString() ?? '';
          const value = draft.trim() === '' ? undefined : Number(draft);
          const parsed = DeploymentCreationDefaultsV1Schema.safeParse({ ...preferences, retainPreviousDeployments: value });
          if (!parsed.success) return preferences.retainPreviousDeployments?.toString() ?? '';
          change('retainPreviousDeployments', value);
          return value?.toString() ?? '';
        }} />
      <SegmentedChoiceItem<'off' | 'configured'> testIDPrefix="deployment-defaults.alertChannels"
        title={t('settings.notifications')} subtitle={alertUnavailable
          ? t('projects.deployments.backupStatusUnavailable') : origin(resolved.sources.alertChannels)}
        disabled={props.disabled || selectingAlert}
        value={alertChannels.length === 0 ? 'off' : 'configured'} valueSource={inherited('alertChannels')}
        options={[{ id: 'off', label: t('common.off') }, { id: 'configured', label: t('common.on') }]}
        onChange={value => {
          if (props.disabled || selectingAlert) return;
          if (value === 'off') { change('alertChannels', []); return; }
          if (!preferences.alertChannels?.length) void selectAlert();
        }} />
      {preferences.alertChannels?.map((channel, index) => <Item
        key={`${channel.channelId}:${index}`} testID={`deployment-defaults.alertChannels.${index}`}
        title={channel.channelId} disabled={props.disabled || selectingAlert}
        onPress={() => selectAlert(index)} rightElementOutsidePressable
        rightElement={<IconButton testID={`deployment-defaults.alertChannels.remove.${index}`}
          iconName="trash" accessibilityLabel={`${t('common.remove')} ${channel.channelId}`}
          variant="plain" disabled={props.disabled || selectingAlert}
          onPress={() => change('alertChannels', preferences.alertChannels?.filter((_, position) => position !== index))} />} />)}
      {preferences.alertChannels?.length ? <Item testID="deployment-defaults.alertChannels.add"
        title={t('common.add')} disabled={props.disabled || selectingAlert} onPress={() => selectAlert()} /> : null}
    </ItemGroup>
    <ItemGroup testID="deployment-defaults.previews" title={t('projects.deployments.settingsSections.previewsTitle')}>
      <SessionMachineField testID="deployment-defaults.previewMachine" serverId={props.serverId}
        title={t('projects.deployments.settingsSections.previewsRunsOn')}
        machineId={preferences.previewMachineId ?? null}
        machineName={resolved.values.previewMachineId ?? null}
        subtitle={origin(resolved.sources.previewMachineId)}
        defaultChoice={{ title: props.inheritLabel, value: previewMachine ?? resolved.values.previewMachineId ?? target,
          onChoose: () => change('previewMachineId', undefined) }}
        awayMachinesChoosable disabled={props.disabled} onSelectMachine={machine => change('previewMachineId', machine.id)} />
      <SegmentedChoiceItem<'none' | 'own' | 'branch'> testIDPrefix="deployment-defaults.previewDatabase"
        title={t('projects.deployments.settingsSections.previewsData')}
        subtitle={origin(resolved.sources.previewDatabase)} disabled={props.disabled}
        value={previewDatabase} valueSource={inherited('previewDatabase')}
        options={[
          { id: 'none', label: t('projects.deployments.settingsSections.previewsDataNone') },
          { id: 'own', label: t('projects.deployments.settingsSections.previewsDataOwn') },
          { id: 'branch', label: t('projects.deployments.settingsSections.previewsDataBranch') },
        ]} onChange={value => change('previewDatabase', value)} />
    </ItemGroup>
    <ItemGroup testID="deployment-defaults.backups" title={t('projects.deployments.sectionBackups')}>
      <DropdownMenu testID="deployment-defaults.backupDestination" open={destinationOpen}
        onOpenChange={open => setDestinationOpen(open && !props.disabled)} items={destinationItems} selectedId={destinationId}
        onSelect={id => {
          setDestinationOpen(false);
          if (id === 'inherit' || id === 'off') { change('backupDestination', id === 'inherit' ? undefined : null); return; }
          const entry = destinations.find(candidate => buildQualifiedPluginContributionKey({ pluginId: candidate.pluginId,
            localId: candidate.definition.id }) === id);
          if (entry && projection.interactionEnabled) change('backupDestination', { pluginId: entry.pluginId, localId: entry.definition.id });
        }} itemTrigger={{ title: t('projects.deployments.backupDestination'), icon: null,
          subtitle: origin(resolved.sources.backupDestination),
          detailFormatter: selected => destinationId === 'inherit' ? inheritedDestinationName : selected?.title ?? null,
          itemProps: { disabled: props.disabled, accessoryLayout: 'adaptive' } }} />
      <SegmentedChoiceItem<'off' | 'custom'> testIDPrefix="deployment-defaults.backupSchedule"
        title={t('workflows.triggers.kind.schedule')} subtitle={origin(resolved.sources.backupSchedule)}
        disabled={props.disabled} value={schedule === undefined ? null : schedule === null ? 'off' : 'custom'}
        valueSource={inherited('backupSchedule')}
        options={[{ id: 'off', label: t('common.off') }, { id: 'custom', label: t('common.on') }]}
        onChange={value => {
          if (value === 'off') { change('backupSchedule', null); return; }
          const initial = buildTriggerDefinition({ when: createDefaultWhen('schedule'), enabled: true, sessionId: null });
          if (initial?.kind === 'schedule') change('backupSchedule', initial.schedule);
        }} />
      {preferences.backupSchedule && !props.disabled ? <ScheduleRows testID="deployment-defaults.backupSchedule.fields"
        when={readScheduleWhen(preferences.backupSchedule)} onChange={when => {
          const trigger = buildTriggerDefinition({ when, enabled: true, sessionId: null });
          if (trigger?.kind === 'schedule') change('backupSchedule', trigger.schedule);
        }} /> : null}
      <SegmentedChoiceItem testIDPrefix="deployment-defaults.backupRetention"
        title={t('projects.deployments.backupKeeps')}
        // What the counts do is said once, here, not under each count row (sibling rows never repeat a sentence).
        subtitle={[origin(resolved.sources.backupRetention), t('projects.deployments.settingsSections.keepDescription')]
          .filter(Boolean).join(' · ')} disabled={props.disabled}
        value={retention.kind === 'keepEverything' ? 'all' : 'counts'} valueSource={inherited('backupRetention')}
        options={[{ id: 'all', label: t('projects.deployments.backupKeepEverything') },
          { id: 'counts', label: t('projects.deployments.settingsSections.keepTitle'), disabled: true }]}
        onChange={value => {
          if (value === 'counts') return;
          change('backupRetention', { kind: 'keepEverything' });
        }} />
      {deploymentBackupKeepFields.map(field => <FieldValueItem key={field} testID={`deployment-defaults.backupRetention.${field}`}
        title={t(`projects.deployments.settingsSections.${deploymentBackupKeepLabels[field]}`)}
        kind="integer" allowEmpty disabled={props.disabled}
        value={preferences.backupRetention ? retentionDraft[field] : ''}
        // A count that follows a default (or keeps every backup) shows what it holds, muted.
        placeholder={retentionDraft[field] === '' ? '0' : retentionDraft[field]}
        stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }} compactStepper
        onCommit={value => {
          const parsed = retentionFromDraft({ ...retentionDraft, [field]: value });
          if (parsed) change('backupRetention', parsed);
          return preferences.backupRetention ? retentionDraft[field] : '';
        }} />)}
    </ItemGroup>
    {changed ? <ItemGroup testID="deployment-defaults.reset">
      <Item testID="deployment-defaults.reset.button" title={props.resetLabel} accessibilityRole="button"
        disabled={props.disabled} showChevron={false} onPress={() => { if (!props.disabled) props.onChange(() => ({})); }} />
    </ItemGroup> : null}
  </>;
}

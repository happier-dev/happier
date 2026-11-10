import * as React from 'react';
import type { DeploymentCreationDefaultsV1, DeploymentCreationDefaultSourceV1,
  ResolvedDeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
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
import { EnvironmentMachineChoice } from './EnvironmentMachineChoice';
import { deploymentBackupKeepFields, deploymentBackupKeepLabels, deploymentBackupRetentionDraftFrom,
  retentionFromDraft } from './deploymentBackupRetention';

const destinationSections = Object.freeze(['familiesById.backupDestinations']);
type Preferences = DeploymentCreationDefaultsV1;

/** Preference authoring only; setup resolves these choices through the shared host preparation. */
export function DeploymentExtraDefaultsRows(props: Readonly<{
  serverId: string;
  preferences: Preferences;
  resolved: ResolvedDeploymentCreationDefaultsV1;
  inheritLabel: string;
  disabled: boolean;
  onChange: (next: Preferences) => void;
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
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    if (props.disabled) return;
    const next = { ...preferences };
    if (value === undefined) delete next[key];
    else next[key] = value;
    props.onChange(next);
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
      if (selected.kind === 'notificationDestination') change('alertChannels', index === undefined
        ? [...(preferences.alertChannels ?? []), selected.channel]
        : preferences.alertChannels?.map((channel, position) => position === index ? selected.channel : channel));
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
          : t('projects.deployments.backupStatusUnavailable') });
  }
  if (!destinationItems.some(entry => entry.id === destinationId) && preferences.backupDestination) {
    destinationItems.push({ id: destinationId, title: preferences.backupDestination.localId,
      subtitle: t('projects.deployments.backupStatusUnavailable'), disabled: true });
  }
  const retention = preferences.backupRetention ?? resolved.values.backupRetention ?? { kind: 'keepEverything' as const };
  const retentionDraft = deploymentBackupRetentionDraftFrom(retention);
  const schedule = preferences.backupSchedule;
  return <>
    <SegmentedChoiceItem<'inherit' | 'off' | 'configured'> testIDPrefix="deployment-defaults.alertChannels"
      title={t('settings.notifications')} subtitle={alertUnavailable
        ? t('projects.deployments.backupStatusUnavailable') : props.sourceLabel(resolved.sources.alertChannels)}
      disabled={props.disabled || selectingAlert}
      value={preferences.alertChannels === undefined ? 'inherit' : preferences.alertChannels.length === 0 ? 'off' : 'configured'}
      options={[{ id: 'inherit', label: props.inheritLabel }, { id: 'off', label: t('common.off') },
        { id: 'configured', label: t('common.on') }]}
      onChange={value => {
        if (props.disabled || selectingAlert) return;
        if (value !== 'configured') { change('alertChannels', value === 'inherit' ? undefined : []); return; }
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
    <EnvironmentMachineChoice testID="deployment-defaults.previewMachine" serverId={props.serverId} icon={null}
      title={`${t('projects.deployments.settingsSections.previewsTitle')} · ${t('projects.deployments.settingsSections.previewsRunsOn')}`}
      currentMachineId={preferences.previewMachineId ?? null}
      fallback={resolved.values.previewMachineId ?? props.inheritLabel}
      subtitle={props.sourceLabel(resolved.sources.previewMachineId)}
      defaultChoice={{ title: props.inheritLabel, onChoose: () => change('previewMachineId', undefined) }}
      disabled={props.disabled} onChoose={id => change('previewMachineId', id)} />
    <SegmentedChoiceItem<'inherit' | 'none' | 'own' | 'branch'> testIDPrefix="deployment-defaults.previewDatabase"
      title={`${t('projects.deployments.settingsSections.previewsTitle')} · ${t('projects.deployments.settingsSections.previewsData')}`}
      subtitle={props.sourceLabel(resolved.sources.previewDatabase)} disabled={props.disabled}
      value={preferences.previewDatabase ?? 'inherit'}
      options={[
        { id: 'inherit', label: props.inheritLabel },
        { id: 'none', label: t('projects.deployments.settingsSections.previewsDataNone') },
        { id: 'own', label: t('projects.deployments.settingsSections.previewsDataOwn') },
        { id: 'branch', label: t('projects.deployments.settingsSections.previewsDataBranch') },
      ]} onChange={value => change('previewDatabase', value === 'inherit' ? undefined : value)} />
    <DropdownMenu testID="deployment-defaults.backupDestination" open={destinationOpen}
      onOpenChange={open => setDestinationOpen(open && !props.disabled)} items={destinationItems} selectedId={destinationId}
      onSelect={id => {
        setDestinationOpen(false);
        if (id === 'inherit' || id === 'off') { change('backupDestination', id === 'inherit' ? undefined : null); return; }
        const entry = destinations.find(candidate => buildQualifiedPluginContributionKey({ pluginId: candidate.pluginId,
          localId: candidate.definition.id }) === id);
        if (entry && projection.interactionEnabled) change('backupDestination', { pluginId: entry.pluginId, localId: entry.definition.id });
      }} itemTrigger={{ title: t('projects.deployments.backupDestination'), icon: null,
        subtitle: props.sourceLabel(resolved.sources.backupDestination),
        detailFormatter: selected => selected?.title ?? props.inheritLabel,
        itemProps: { disabled: props.disabled, accessoryLayout: 'adaptive' } }} />
    <SegmentedChoiceItem testIDPrefix="deployment-defaults.backupSchedule"
      title={t('workflows.triggers.kind.schedule')} subtitle={props.sourceLabel(resolved.sources.backupSchedule)}
      disabled={props.disabled} value={schedule === undefined ? 'inherit' : schedule === null ? 'off' : 'custom'}
      options={[{ id: 'inherit', label: props.inheritLabel }, { id: 'off', label: t('common.off') },
        { id: 'custom', label: t('common.on') }]}
      onChange={value => {
        if (value === 'inherit' || value === 'off') { change('backupSchedule', value === 'inherit' ? undefined : null); return; }
        const initial = buildTriggerDefinition({ when: createDefaultWhen('schedule'), enabled: true, sessionId: null });
        if (initial?.kind === 'schedule') change('backupSchedule', initial.schedule);
      }} />
    {schedule && !props.disabled ? <ScheduleRows testID="deployment-defaults.backupSchedule.fields"
      when={readScheduleWhen(schedule)} onChange={when => {
        const trigger = buildTriggerDefinition({ when, enabled: true, sessionId: null });
        if (trigger?.kind === 'schedule') change('backupSchedule', trigger.schedule);
      }} /> : null}
    <SegmentedChoiceItem testIDPrefix="deployment-defaults.backupRetention"
      title={t('projects.deployments.backupKeeps')}
      subtitle={props.sourceLabel(resolved.sources.backupRetention)} disabled={props.disabled}
      value={preferences.backupRetention === undefined ? 'inherit' : preferences.backupRetention.kind === 'keepEverything' ? 'all' : 'counts'}
      options={[{ id: 'inherit', label: props.inheritLabel }, { id: 'all', label: t('projects.deployments.backupKeepEverything') },
        { id: 'counts', label: t('projects.deployments.settingsSections.keepTitle'), disabled: true }]}
      onChange={value => {
        if (value === 'counts') return;
        change('backupRetention', value === 'inherit' ? undefined : { kind: 'keepEverything' });
      }} />
    {deploymentBackupKeepFields.map(field => <FieldValueItem key={field} testID={`deployment-defaults.backupRetention.${field}`}
      title={t(`projects.deployments.settingsSections.${deploymentBackupKeepLabels[field]}`)}
      subtitle={t('projects.deployments.settingsSections.keepDescription')}
      kind="integer" allowEmpty disabled={props.disabled} value={retentionDraft[field]}
      stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }} compactStepper
      onCommit={value => {
        const parsed = retentionFromDraft({ ...retentionDraft, [field]: value });
        if (parsed) change('backupRetention', parsed);
        return retentionDraft[field];
      }} />)}
  </>;
}

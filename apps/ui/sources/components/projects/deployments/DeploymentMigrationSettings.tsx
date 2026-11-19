import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { OwnServerEnvironmentConfigurationV1Schema } from '@happier-dev/deployments/contracts/v1';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { InlineFormActions } from '@/components/ui/forms/InlineAddExpander';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { useDeploymentChangePress } from './deploymentActionOutcome';

const id = 'project-deployments.environment.settings.migration';
type Policy = NonNullable<DeploymentEnvironmentReadDetailV1['content']['ownServer']>;
const noop = () => {};

/** The Environment's saved candidate command; the native migration owner still decides execution and recovery. */
export function DeploymentMigrationSettings(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1; editing: DeploymentEnvironmentEditing | null; machineName: (id: string) => string;
}>) {
  const policy = props.detail.content.ownServer;
  const editing = props.editing;
  const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
  const [editingCommand, setEditingCommand] = React.useState(false);
  const [service, setService] = React.useState(policy?.migration?.service ?? '');
  const [argv, setArgv] = React.useState(policy?.migration?.argv.join('\n') ?? '');
  const [pending, setPending] = React.useState(policy?.migration?.pendingCheck?.argv.join('\n') ?? '');
  const [backup, setBackup] = React.useState(policy?.backupBeforeMigration !== false);
  const [recovery, setRecovery] = React.useState<Policy['migrationFailurePolicy']>(policy?.migrationFailurePolicy ?? 'ask');
  if (!policy) return null;
  const open = () => {
    setService(policy.migration?.service ?? ''); setArgv(policy.migration?.argv.join('\n') ?? '');
    setPending(policy.migration?.pendingCheck?.argv.join('\n') ?? '');
    setBackup(policy.backupBeforeMigration !== false); setRecovery(policy.migrationFailurePolicy ?? 'ask'); setEditingCommand(true);
  };
  const candidate = OwnServerEnvironmentConfigurationV1Schema.safeParse({ ...policy,
    migration: { service, argv: argv.split('\n'), ...(pending ? { pendingCheck: { argv: pending.split('\n') } } : {}) },
    backupBeforeMigration: backup, migrationFailurePolicy: recovery });
  const save = () => {
    if (!editing || !candidate.success) return;
    void change.press(() => editing.actions.updateEnvironment(props.detail.environment, { ownServer: {
      migration: candidate.data.migration, backupBeforeMigration: backup, migrationFailurePolicy: recovery,
    } })).then(success => { if (success) setEditingCommand(false); });
  };
  return <><ItemGroup testID={id} title={t('projects.deployments.settingsSections.migrationTitle')}
    description={t('projects.deployments.settingsSections.migrationBody')}
    action={editing && !editingCommand ? <SectionActionButton testID={`${id}.edit`}
      icon={policy.migration ? 'pencil' : 'plus'} title={t(policy.migration ? 'common.edit' : 'common.add')} onPress={open} disabled={change.running} /> : undefined}>
    {editing && editingCommand ? <>
      <FieldValueItem title={t('projects.deployments.settingsSections.migrationService')} value={service}
        fieldTestID={`${id}.service.input`} onDraftChange={setService} onCommit={value => { setService(value); }} disabled={change.running} />
      <Item title={t('projects.deployments.settingsSections.migrationCommand')}
        subtitle={t('projects.deployments.settingsSections.migrationArgumentsBody')} accessoryLayout="stacked"
        rightElement={<FieldTextInput testID={`${id}.argv.input`} value={argv} onChangeText={setArgv} multiline monospace
          accessibilityLabel={t('projects.deployments.settingsSections.migrationCommand')} editable={!change.running} />} />
      <Item title={t('projects.deployments.settingsSections.migrationPending')}
        subtitle={t('projects.deployments.settingsSections.migrationPendingBody')} accessoryLayout="stacked"
        rightElement={<FieldTextInput testID={`${id}.pending.input`} value={pending} onChangeText={setPending} multiline monospace
          accessibilityLabel={t('projects.deployments.settingsSections.migrationPending')} editable={!change.running} />} />
      <Item title={t('projects.deployments.settingsSections.migrationBackup')} rightElement={<Switch value={backup}
        onValueChange={setBackup} disabled={change.running} />} />
      <SegmentedChoiceItem testID={`${id}.recovery`} testIDPrefix={`${id}.recovery`} accessoryLayout="stacked"
        title={t('projects.deployments.settingsSections.migrationRecovery')} value={recovery ?? 'ask'} disabled={change.running}
        options={[
          { id: 'ask', label: t('projects.deployments.settingsSections.migrationAsk') },
          { id: 'restoreBackupAndRollbackCode', label: t('projects.deployments.settingsSections.migrationRestore') },
          { id: 'rollbackCodeOnly', label: t('projects.deployments.settingsSections.migrationCode') },
        ]} onChange={setRecovery} />
      {recovery !== 'ask' ? <Item title={t('projects.deployments.settingsSections.migrationWarning')} mode="info" /> : null}
    </> : <>
      <Item title={policy.migration?.service ?? t('projects.deployments.settingsSections.migrationNone')}
        subtitle={policy.migration?.argv.join(' · ')} mode="info" />
      {policy.migration?.pendingCheck ? <Item title={t('projects.deployments.settingsSections.migrationPending')}
        subtitle={policy.migration.pendingCheck.argv.join(' · ')} mode="info" /> : null}
      {policy.migration ? <Item title={t('projects.deployments.settingsSections.migrationBackup')}
        detail={t(policy.backupBeforeMigration === false ? 'common.off' : 'common.on')} mode="info" /> : null}
      {policy.migration ? <Item title={t('projects.deployments.settingsSections.migrationRecovery')}
        subtitle={t(policy.migrationFailurePolicy === 'restoreBackupAndRollbackCode'
          ? 'projects.deployments.settingsSections.migrationRestore' : policy.migrationFailurePolicy === 'rollbackCodeOnly'
            ? 'projects.deployments.settingsSections.migrationCode' : 'projects.deployments.settingsSections.migrationAsk')} mode="info" /> : null}
      {policy.migration && editing ? <Item testID={`${id}.remove`} title={t('common.remove')} disabled={change.running}
        onPress={() => { void change.press(() => editing.actions.updateEnvironment(props.detail.environment, { ownServer: { migration: null } })); }} /> : null}
    </>}
    {change.outcome && editing ? <DeployOutcomeBanner controller={change.banner}
      machine={props.machineName(props.detail.environment.controllerMachineId)} copy="setting" /> : null}
  </ItemGroup>
  {/* A form of sheet rows ends after its sheet: its one primary, then a quiet Cancel (R2-D15 ruling). */}
  {editing && editingCommand ? <ItemGroup surface="none"><InlineFormActions saveLabel={t('common.save')} cancelLabel={t('common.cancel')}
    onSave={save} saveDisabled={change.running || !candidate.success} saving={change.running}
    onCancel={() => setEditingCommand(false)} saveTestID={`${id}.save`} cancelTestID={`${id}.cancel`} /></ItemGroup> : null}</>;
}

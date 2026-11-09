import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { Button, Item, ItemGroup, List, Select, Stack, Text, TextField, defineUiSurface, usePluginTranslation } from '@happier-dev/plugin-ui';
import { PluginAgentSettingsLaunchInputV1Schema, type PluginAgentSettingsLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginSettingsAdministrationActionOutputV1Schema } from '@happier-dev/protocol/plugins/settingsAdministration';
import { CLAUDE_SESSION_RETENTION_SETTING_ID, ClaudeSessionRetentionPolicyV1Schema } from '@happier-dev/protocol/agents/claude/session-retention';
import { readRetentionMachineReport, retentionChangeNeedsConfirmation, retentionMachineStatus, sameRetentionPolicy, type RetentionPolicy, type RetentionMachineStatus } from './sessionRetentionPresentation.js';

type Machine = PluginAgentSettingsLaunchInputV1['machines'][number];
const prefix = 'settingsAgents.plugins.claude.sessionRetention.';
type Translate = (key: string, fallback: string) => string;
const statusFallback: Readonly<Record<RetentionMachineStatus, string>> = {
  applied: 'Configured', unmanagedStatus: 'Keeping existing settings', pending: 'Waiting for machine',
  unknown: 'Status unavailable', error: 'Could not apply', managed: 'Organization policy may override retention',
};

function targetReason(reason: string | undefined, tr: Translate): string | undefined {
  switch (reason) {
    case 'invalid_settings': return tr('invalidSettings', 'Repair the malformed Claude settings file, then reconnect to retry.');
    case 'settings_permission_denied': return tr('permissionDenied', 'Check Claude settings file permissions, then reconnect to retry.');
    case 'managed_settings_unreadable': return tr('managedUnreadable', 'Organization policy could not be read. Check Claude settings and file permissions.');
    case 'managed_settings_detected': return tr('managed', 'Organization policy may override retention');
    case undefined: return undefined;
    default: return tr('writeFailed', 'Could not update Claude settings. Check the machine and reconnect to retry.');
  }
}

const MachineRow = React.memo(function MachineRow({ machine, policy, tr }: Readonly<{ machine: Machine; policy: RetentionPolicy; tr: Translate }>) {
  const [expanded, setExpanded] = React.useState(false);
  const report = readRetentionMachineReport(machine);
  const status = retentionMachineStatus(machine, policy);
  const genericFailure = !report && status === 'error';
  const statusText = tr(status, statusFallback[status]);
  return <Item title={machine.displayName} testID={`claude-session-retention-machine-${machine.id}`}
    subtitle={machine.online ? statusText : `${statusText} · ${tr('offline', 'Offline · last confirmed status')}`}
    expanded={expanded} accessibilityExpanded={expanded}
    onPress={report?.targets.length || genericFailure ? () => setExpanded(value => !value) : undefined}
    expandedContent={expanded ? genericFailure
      ? <Text>{targetReason('provider_settings_failed', tr)}</Text>
      : report ? <Stack style={{ height: 240 }}><List items={report.targets} keyForItem={target => target.id}
        renderItem={target => {
          const title = target.id === 'native' ? tr('native', 'Default Claude configuration')
            : `${tr(target.id.includes(':group:') ? 'group' : 'profile', target.id.includes(':group:') ? 'Group' : 'Profile')} ${target.id}`;
          const targetStatus = !sameRetentionPolicy(report.policy, policy) ? 'pending'
            : target.status === 'unmanaged' ? 'unmanagedStatus' : target.status;
          const configured = target.currentDays === null ? tr(targetStatus, statusFallback[targetStatus])
            : `${tr(targetStatus, statusFallback[targetStatus])} · ${tr('customDays', 'Days')}: ${target.currentDays.toLocaleString()}`;
          return <Item title={title} subtitle={targetReason(target.reason, tr) ?? configured} />;
        }} /></Stack> : null : null} />;
});

function ClaudeAgentSettings(context: RenderContext): React.ReactElement | null {
  const translate = usePluginTranslation();
  const tr = React.useCallback((key: string, fallback: string) => translate(`${prefix}${key}`, fallback), [translate]);
  const parsed = React.useMemo(() => PluginAgentSettingsLaunchInputV1Schema.safeParse(context.launchInput), [context.launchInput]);
  const [custom, setCustom] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [writeError, setWriteError] = React.useState(false);
  const [machinesExpanded, setMachinesExpanded] = React.useState(false);
  if (!parsed.success) return <ItemGroup title={tr('title', 'Local session history')}><Item title={tr('unknown', 'Status unavailable')} /></ItemGroup>;
  const input = parsed.data;
  const selected = ClaudeSessionRetentionPolicyV1Schema.safeParse(input.account.values[CLAUDE_SESSION_RETENTION_SETTING_ID]);
  const policy = selected.success ? selected.data : null;
  const selectedId = policy === null ? 'unmanaged' : policy.mode === 'providerDefault' ? 'providerDefault'
    : policy.days === 365 ? 'year' : policy.days === 36500 ? 'century' : 'custom';
  const currentDraft = custom ? draft : policy?.mode === 'days' ? String(policy.days) : draft;
  const customPolicy = ClaudeSessionRetentionPolicyV1Schema.safeParse({ mode: 'days', days: Number(currentDraft) });
  const validCustom = /^\d+$/.test(currentDraft) && customPolicy.success;
  const disabled = busy || !input.account.ready || input.account.loading || input.account.writePending || input.account.revision === null;
  const apply = async (next: RetentionPolicy) => {
    const revision = input.account.revision;
    if (disabled || revision === null || sameRetentionPolicy(next, policy)) return;
    setBusy(true);
    setWriteError(false);
    try {
      if (retentionChangeNeedsConfirmation(next, policy, input.machines) && !await context.hostApi.confirm(
        tr('confirmBody', 'Shorter retention can delete older local Claude history. Continue?'),
        { title: tr('confirmTitle', 'Change local history retention?'), signal: context.signal },
      )) return;
      context.signal.throwIfAborted();
      const result = PluginSettingsAdministrationActionOutputV1Schema.parse(await context.hostApi.executeAction('plugins.settings.set', {
        pluginId: context.plugin.id, scope: { kind: 'account' }, target: { kind: 'account' },
        localId: CLAUDE_SESSION_RETENTION_SETTING_ID, value: next, expectedRevision: revision,
      }, { signal: context.signal }));
      if (!result.ok || result.kind !== 'plugins.settings.set') throw new Error('retention_write_failed');
      setCustom(false);
    } catch {
      if (!context.signal.aborted) setWriteError(true);
    } finally {
      if (!context.signal.aborted) setBusy(false);
    }
  };
  return <ItemGroup title={tr('title', 'Local session history')}
    description={tr('footer', 'Configures user-level Claude retention. Project, organization, and explicit launch settings can override it.')}>
    <Item title={tr('policy', 'Keep local history')}
      subtitle={selectedId === 'unmanaged' ? tr('unmanagedHint', 'Stop managing retention. This does not undo previous changes.')
        : selectedId === 'providerDefault' ? tr('providerDefaultHint', 'Remove the configured user-level retention value.') : undefined}
      accessoryOutsidePressable accessory={<Select testID="claude-session-retention-policy" label={tr('policy', 'Keep local history')} presentation="field"
      value={custom ? 'custom' : selectedId} disabled={disabled}
      options={[
        { value: 'unmanaged', label: tr('unmanaged', 'Keep existing settings'), description: tr('unmanagedHint', 'Stop managing retention. This does not undo previous changes.') },
        { value: 'providerDefault', label: tr('providerDefault', 'Claude default'), description: tr('providerDefaultHint', 'Remove the configured user-level retention value.') },
        { value: 'year', label: tr('year', '1 year (365 days)') },
        { value: 'century', label: tr('century', '100 years (36,500 days)') },
        { value: 'custom', label: tr('custom', 'Custom') },
      ]} onChange={value => {
        if (value === 'custom') { setDraft(policy?.mode === 'days' ? String(policy.days) : ''); setCustom(true); return; }
        if (value === 'unmanaged') void apply(null);
        else if (value === 'providerDefault') void apply({ mode: 'providerDefault' });
        else if (value === 'year' || value === 'century') void apply({ mode: 'days', days: value === 'year' ? 365 : 36500 });
      }} />} />
    {custom || selectedId === 'custom' ? <Stack gap="medium">
      <Item title={tr('customDays', 'Days')} accessoryOutsidePressable accessory={<TextField testID="claude-session-retention-custom-days" label={tr('customDays', 'Days')}
        value={currentDraft} keyboardType="numeric" disabled={busy} presentation="field"
        onChange={value => { setDraft(value); setCustom(true); }}
        error={currentDraft !== '' && !validCustom ? tr('invalidDays', 'Enter a positive whole number of days.') : undefined} />} />
      <Button testID="claude-session-retention-custom-apply" title={tr('confirmAction', 'Apply retention')}
        disabled={disabled || !validCustom} busy={busy} onPress={() => customPolicy.success ? apply(customPolicy.data) : undefined} />
    </Stack> : null}
    {writeError || input.account.error ? <Text>{tr('writeFailed', 'Could not save retention. Check your connection and try again.')}</Text> : null}
    <Item testID="claude-session-retention-machines" title={tr('machines', 'Machine status')}
      detail={String(input.machines.length)} expanded={machinesExpanded} accessibilityExpanded={machinesExpanded}
      onPress={() => setMachinesExpanded(value => !value)}
      expandedContent={machinesExpanded ? <Stack style={{ height: 320 }}><List items={input.machines}
        keyForItem={machine => machine.id} renderItem={machine => <MachineRow key={machine.id} machine={machine} policy={policy} tr={tr} />}
        empty={<Text>{tr('noMachines', 'Pair a machine to see its configured retention.')}</Text>} /></Stack> : null} />
  </ItemGroup>;
}

export const renderSurface: RenderSurface = defineUiSurface(ClaudeAgentSettings);

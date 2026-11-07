import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeSessionRetentionReportV1 } from '@happier-dev/protocol/agents/claude/session-retention';

import { resolveClaudeManagedConfigDir } from '../environment.js';
import { readClaudeManagedRetention } from './managedRetention.js';
import { applyClaudeSessionRetentionSettings, readClaudeSessionRetentionPolicy } from './sessionRetention.js';

/** The host owns home inventory; this leaf owns Claude's settings meaning and edit. */
export async function applyClaudeAccountSettings(input: Readonly<{
  pluginSettings: AgentCliSessionCommandPluginSettingsV1;
  targets: readonly Readonly<{ id: string; directory: string }>[];
}>, systemSettingsDir = resolveClaudeManagedConfigDir()): Promise<ClaudeSessionRetentionReportV1> {
  const policy = readClaudeSessionRetentionPolicy(input.pluginSettings.account ?? {});
  const targets: ClaudeSessionRetentionReportV1['targets'] = [];
  for (const target of input.targets) {
    targets.push(await applyClaudeSessionRetentionSettings({
      configDir: target.directory,
      id: target.id,
      policy,
    }));
  }
  const managed = await readClaudeManagedRetention(systemSettingsDir);
  const report: ClaudeSessionRetentionReportV1 = {
    policy,
    targets: targets.map((target) => target.status !== 'applied' || managed === 'absent' ? target : {
      ...target,
      status: managed === 'present' ? 'managed' : 'error',
      reason: managed === 'present' ? 'managed_settings_detected' : 'managed_settings_unreadable',
    }),
  };
  if (policy) {
    for (const target of report.targets) {
      if (target.status !== 'error') continue;
      console.warn('[claude] Local session retention could not be applied', {
        targetId: target.id,
        reason: target.reason ?? 'settings_write_failed',
      });
    }
  }
  return report;
}

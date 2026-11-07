import { join } from 'node:path';

import { AGENTS_CORE } from '@happier-dev/agents';
import type { AccountSettings, ClaudeSessionRetentionReportV1 } from '@happier-dev/protocol';

import { resolveClaudeConnectedServiceStableConfigDir } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceStableAuthDir';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { listMaterializedHomeTargets } from '@/daemon/connectedServices/materialize/cleanup/connectedServiceMaterializedHomeTargets';
import { resolveConnectedServiceGroupsHomesDir, resolveConnectedServiceHomesDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { applyClaudeSessionRetentionSettings, readClaudeSessionRetentionPolicy } from './claudeSessionRetentionSettings';
import { readClaudeManagedRetention, resolveClaudeManagedSettingsDir } from './readClaudeManagedRetention';

export async function applyClaudeAccountSettings(params: Readonly<{
  accountSettings: AccountSettings;
  processEnv: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<ClaudeSessionRetentionReportV1> {
  const policy = readClaudeSessionRetentionPolicy(params.accountSettings);
  const targets: ClaudeSessionRetentionReportV1['targets'] = [await applyClaudeSessionRetentionSettings({
    configDir: resolveConfiguredClaudeConfigDir({ env: params.processEnv }), id: 'native', policy,
  })];
  try {
    for (const serviceId of AGENTS_CORE.claude.connectedServices.supportedServiceIds) {
      for (const kind of ['profile', 'group'] as const) {
        const baseDir = kind === 'profile'
          ? join(resolveConnectedServiceHomesDir(params), serviceId)
          : resolveConnectedServiceGroupsHomesDir({ ...params, serviceId });
        const homes = await listMaterializedHomeTargets(baseDir);
        for (const home of homes.filter((home) => home.agentId === 'claude').sort((a, b) => a.materializationIdentityId.localeCompare(b.materializationIdentityId))) {
          const id = home.materializationIdentityId;
          const configDir = resolveClaudeConnectedServiceStableConfigDir({
            ...params, serviceId, fallbackProfileId: id,
            selection: kind === 'profile' ? { kind, profileId: id } : { kind, groupId: id },
          });
          if (configDir) targets.push(await applyClaudeSessionRetentionSettings({ configDir, id: `${serviceId}:${kind}:${id}`, policy }));
        }
      }
    }
  } catch {
    // Discovery is part of the result: never report all profiles configured after a failed scan.
    targets.push({ id: 'connectedServices', status: 'error', currentDays: null, reason: 'profile_discovery_failed' });
  }
  const managedSettingsDir = resolveClaudeManagedSettingsDir();
  const managed = managedSettingsDir ? await readClaudeManagedRetention(managedSettingsDir) : 'absent';
  return {
    policy,
    targets: targets.map((target) => target.status !== 'applied' || managed === 'absent' ? target : {
      ...target,
      status: managed === 'present' ? 'managed' : 'error',
      reason: managed === 'present' ? 'managed_settings_detected' : 'managed_settings_unreadable',
    }),
  };
}

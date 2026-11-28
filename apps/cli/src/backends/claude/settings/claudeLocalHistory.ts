import {
  DirectSessionRetentionDaysSchema,
  type DirectSessionRetentionRequest,
  type DirectSessionRetentionState,
} from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { resolveClaudeConfigDirForDirectSessions } from '../directSessions/resolveClaudeConfigDir';
import {
  applyClaudeSessionRetentionSettings,
  CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
  readClaudeSessionRetentionPolicy,
} from './claudeSessionRetentionSettings';
import { resolveClaudeManagedSettingsDir } from './readClaudeManagedRetention';

const CLAUDE_NEVER_DAYS = 36500;

export async function readOrWriteClaudeLocalHistoryRetention(
  request: DirectSessionRetentionRequest,
  expectedCurrentDays?: number | null,
): Promise<DirectSessionRetentionState & { changedSincePreview?: boolean }> {
  const days = request.operation === 'write' ? DirectSessionRetentionDaysSchema.parse(request.days) : null;
  const target = await applyClaudeSessionRetentionSettings({
    configDir: resolveClaudeConfigDirForDirectSessions({ source: request.source, env: process.env }),
    id: 'native',
    policy: days === null ? null : { mode: 'days', days: days === 'never' ? CLAUDE_NEVER_DAYS : days },
    managedSettingsDir: resolveClaudeManagedSettingsDir(),
    expectedCurrentDays,
    getLegacyPolicy: () => {
      const snapshot = getActiveAccountSettingsSnapshot();
      return snapshot ? readClaudeSessionRetentionPolicy(snapshot.settings) : undefined;
    },
  });
  const blockedReason = target.reason === 'account_policy_active' ? 'accountPolicy'
    : target.reason === 'account_settings_unavailable' ? 'accountSettingsUnavailable'
    : target.status === 'managed' ? 'managed'
    : target.status === 'error' ? 'unreadable'
    : undefined;
  return {
    currentDays: target.currentDays,
    defaultDays: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
    never: target.currentDays === CLAUDE_NEVER_DAYS,
    writable: blockedReason === undefined,
    ...(blockedReason ? { blockedReason } : {}),
    ...(target.reason === 'retention_changed' ? { changedSincePreview: true } : {}),
  };
}

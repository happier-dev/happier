import { readFile, stat } from 'node:fs/promises';

import { writeAtomicTextFileIfChanged } from '@happier-dev/plugin-sdk/fs';
import {
  CLAUDE_SESSION_RETENTION_SETTING_ID,
  ClaudeSessionRetentionPolicyV1Schema,
  type ClaudeSessionRetentionPolicyV1,
  type ClaudeSessionRetentionReportV1,
} from '@happier-dev/protocol/agents/claude/session-retention';

import { resolveClaudeSettingsFilePath, withClaudeSettingsWriteLock } from '../runtime/terminal/unified/tuiControls/settingsGuard.js';

export function readClaudeCleanupPeriodDays(value: unknown): number | undefined {
  const parsed = ClaudeSessionRetentionPolicyV1Schema.safeParse({ mode: 'days', days: value });
  return parsed.success && parsed.data.mode === 'days' ? parsed.data.days : undefined;
}

/** Values are resolved by the host's existing Account-scoped plugin Settings owner. */
export function readClaudeSessionRetentionPolicy(values: Readonly<Record<string, unknown>>): ClaudeSessionRetentionPolicyV1 | null {
  const parsed = ClaudeSessionRetentionPolicyV1Schema.safeParse(values[CLAUDE_SESSION_RETENTION_SETTING_ID]);
  return parsed.success ? parsed.data : null;
}

type RetentionTarget = ClaudeSessionRetentionReportV1['targets'][number];

/** Persist only Claude's retention key, following linked settings and the native settings guard. */
export async function applyClaudeSessionRetentionSettings(params: Readonly<{
  configDir: string;
  id: string;
  policy: ClaudeSessionRetentionPolicyV1 | null;
}>): Promise<RetentionTarget> {
  const result = (status: RetentionTarget['status'], currentDays: number | null, reason?: string): RetentionTarget => ({
    id: params.id, status, currentDays, ...(reason ? { reason } : {}),
  });
  const edit = async (): Promise<RetentionTarget> => {
    const path = await resolveClaudeSettingsFilePath(params.configDir);
    let settings: Record<string, unknown> = {};
    let mode = 0o600;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result('error', null, 'invalid_settings');
      settings = parsed as Record<string, unknown>;
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if (error instanceof SyntaxError) return result('error', null, 'invalid_settings');
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const currentDays = readClaudeCleanupPeriodDays(settings.cleanupPeriodDays) ?? null;
    if (!params.policy) return result('unmanaged', currentDays);
    if (params.policy.mode === 'providerDefault') {
      if (!Object.hasOwn(settings, 'cleanupPeriodDays')) return result('applied', null);
      delete settings.cleanupPeriodDays;
    } else {
      if (currentDays === params.policy.days) return result('applied', currentDays);
      settings.cleanupPeriodDays = params.policy.days;
    }
    await writeAtomicTextFileIfChanged({ path, contents: `${JSON.stringify(settings, null, 2)}\n`, mode });
    return result('applied', params.policy.mode === 'days' ? params.policy.days : null);
  };
  try {
    // An upgraded unmanaged Account must not create a Claude home or settings guard.
    return params.policy ? await withClaudeSettingsWriteLock(params.configDir, edit) : await edit();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return result('error', null, code === 'EACCES' || code === 'EPERM' ? 'settings_permission_denied' : 'settings_write_failed');
  }
}

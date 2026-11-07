import { mkdir, readFile, stat } from 'node:fs/promises';

import {
  ClaudeSessionRetentionPolicyV1Schema,
  type ClaudeSessionRetentionPolicyV1,
  type ClaudeSessionRetentionReportV1,
} from '@happier-dev/protocol';

import { resolveClaudeSettingsFilePath, withClaudeSettingsWriteLock } from '@/backends/claude/unifiedTerminal/tuiControls/settingsGuard';
import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';

// Claude Code's documented default; an unset native setting is not an explicit retention intent.
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export function readClaudeCleanupPeriodDays(value: unknown): number | undefined {
  const parsed = ClaudeSessionRetentionPolicyV1Schema.safeParse({ mode: 'days', days: value });
  return parsed.success && parsed.data.mode === 'days' ? parsed.data.days : undefined;
}

export function readClaudeSessionRetentionPolicy(settings: Readonly<Record<string, unknown>> | null | undefined): ClaudeSessionRetentionPolicyV1 | null {
  const parsed = ClaudeSessionRetentionPolicyV1Schema.safeParse(settings?.claudeSessionRetentionV1);
  return parsed.success ? parsed.data : null;
}

type RetentionTarget = ClaudeSessionRetentionReportV1['targets'][number];

export async function applyClaudeSessionRetentionSettings(params: Readonly<{
  configDir: string;
  id: string;
  policy: ClaudeSessionRetentionPolicyV1 | null;
}>): Promise<RetentionTarget> {
  const result = (status: RetentionTarget['status'], currentDays: number | null, reason?: string): RetentionTarget => ({
    id: params.id, status, currentDays, ...(reason ? { reason } : {}),
  });
  const edit = async (): Promise<RetentionTarget> => {
    // The settings guard and persistent editor resolve the same file authority for linked homes.
    const path = await resolveClaudeSettingsFilePath(params.configDir);
    let settings: Record<string, unknown> = {};
    let mode = 0o600;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
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
    await mkdir(params.configDir, { recursive: true });
    await writeGeneratedTextAtomicallyIfChanged({ path, contents: `${JSON.stringify(settings, null, 2)}\n`, mode });
    return result('applied', params.policy.mode === 'days' ? params.policy.days : null);
  };
  try {
    // Unmanaged is read-only, including on upgrade; acquiring a guard would create the directory.
    return params.policy ? await withClaudeSettingsWriteLock(params.configDir, edit) : await edit();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return result('error', null, code === 'EACCES' || code === 'EPERM' ? 'settings_permission_denied' : 'settings_write_failed');
  }
}

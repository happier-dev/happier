import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { canonicalizeExternalSessionsPath } from '@/session/external/sourceValidation';

export function expandHomeDirForExternalSessions(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
  const fromEnv =
    typeof params.env.HAPPIER_CLAUDE_CONFIG_DIR === 'string' && params.env.HAPPIER_CLAUDE_CONFIG_DIR.trim().length > 0
      ? params.env.HAPPIER_CLAUDE_CONFIG_DIR.trim()
      : typeof params.env.CLAUDE_CONFIG_DIR === 'string'
        ? params.env.CLAUDE_CONFIG_DIR.trim()
        : '';

  const resolved = fromEnv || join(homedir(), '.claude');
  return expandHomeDirForExternalSessions(resolved) || join(homedir(), '.claude');
}

export function resolveCanonicalConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
  return canonicalizeExternalSessionsPath(resolveConfiguredClaudeConfigDir(params));
}

export function resolveClaudeConfigDir(params: Readonly<{ source: ExternalSessionsSource; env: NodeJS.ProcessEnv }>): string {
  if (params.source.kind !== 'claudeConfig') {
    return join(homedir(), '.claude');
  }
  const fromSource = typeof params.source.configDir === 'string' ? params.source.configDir.trim() : '';
  const resolved = fromSource || resolveConfiguredClaudeConfigDir({ env: params.env });
  return expandHomeDirForExternalSessions(resolved) || join(homedir(), '.claude');
}

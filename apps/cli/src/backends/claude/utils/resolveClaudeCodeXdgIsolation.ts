import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { configuration } from '@/configuration';

export type ClaudeCodeXdgIsolationScope = 'execution_run' | 'session';

/**
 * Returns XDG dir overrides for Claude Code so it does not contend with global
 * version locks under the user's home directory (e.g. `~/.local/share/claude/versions/*`).
 *
 * IMPORTANT: Do not override HOME/USERPROFILE for Claude Code. Auth tokens and other OS
 * integrations can depend on stable HOME. We only isolate XDG dirs.
 */
export function resolveClaudeCodeXdgIsolation(params: Readonly<{
  backendId: string;
  scope: ClaudeCodeXdgIsolationScope;
  isolationId: string;
}>): Record<string, string> {
  const backendId = String(params.backendId ?? '').trim() || 'claude';
  const scope = params.scope;
  const isolationId = String(params.isolationId ?? '').trim() || 'unknown';

  const xdgRoot = join(configuration.activeServerDir, 'isolation', backendId, scope, isolationId, 'xdg');
  const xdgCacheHome = join(xdgRoot, '.cache');
  const xdgStateHome = join(xdgRoot, '.local', 'state');
  const xdgDataHome = join(xdgRoot, '.local', 'share');

  try {
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(xdgStateHome, { recursive: true });
    mkdirSync(xdgDataHome, { recursive: true });
  } catch {
    // Best-effort: isolation should not fail backend creation.
  }

  return {
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_STATE_HOME: xdgStateHome,
    XDG_DATA_HOME: xdgDataHome,
  };
}


import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/backends/isolation/types';
import { configuration } from '@/configuration';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeExecutionRunPermissionPolicy } from './resolveClaudeExecutionRunPermissionPolicy';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return new ClaudeSdkAgentBackend({
    cwd: opts.cwd,
    modelId: opts.modelId ?? 'default',
    permissionPolicy: resolveClaudeExecutionRunPermissionPolicy(opts.permissionMode),
    settingsPath: opts.isolation?.settingsPath,
    env: opts.isolation?.env,
  });
};

export function resolveIsolation(request: BackendIsolationRequest, baseBundle: BackendIsolationBundle): BackendIsolationBundle {
  const root = join(configuration.activeServerDir, 'isolation', request.backendId, request.scope, request.isolationId);
  const settingsDir = join(root, 'claude');
  const settingsPath = join(settingsDir, 'settings.json');
  const xdgRoot = join(root, 'xdg');
  const xdgCacheHome = join(xdgRoot, '.cache');
  const xdgStateHome = join(xdgRoot, '.local', 'state');
  const xdgDataHome = join(xdgRoot, '.local', 'share');
  try {
    mkdirSync(settingsDir, { recursive: true });
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(xdgStateHome, { recursive: true });
    mkdirSync(xdgDataHome, { recursive: true });
    writeFileSync(settingsPath, '{}', { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Best-effort: isolation should not fail backend creation.
  }
  return {
    ...baseBundle,
    env: {
      ...(baseBundle.env ?? {}),
      // IMPORTANT: Do not override HOME/USERPROFILE for Claude Code. Auth tokens and other
      // OS integrations can depend on stable HOME. We only isolate XDG dirs to prevent
      // cross-process locking issues (e.g. versions download/lock under ~/.local/share/claude).
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      XDG_DATA_HOME: xdgDataHome,
    },
    settingsPath,
  };
}

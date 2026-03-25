import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/runtime/isolation/types';
import { configuration } from '@/configuration';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeExecutionRunPermissionPolicy } from './resolveClaudeExecutionRunPermissionPolicy';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';

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
  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, '{}', { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Best-effort: isolation should not fail backend creation.
  }

  const xdgEnv = resolveClaudeCodeXdgIsolation({
    backendId: request.backendId,
    scope: 'execution_run',
    isolationId: request.isolationId,
  });
  return {
    ...baseBundle,
    env: {
      ...(baseBundle.env ?? {}),
      // IMPORTANT: Do not override HOME/USERPROFILE for Claude Code. Auth tokens and other
      // OS integrations can depend on stable HOME. We only isolate XDG dirs to prevent
      // cross-process locking issues (e.g. versions download/lock under ~/.local/share/claude).
      ...xdgEnv,
    },
    settingsPath,
  };
}

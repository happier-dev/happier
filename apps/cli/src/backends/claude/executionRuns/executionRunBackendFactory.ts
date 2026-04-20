import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/runtime/isolation/types';
import { configuration } from '@/configuration';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';
import { resolvePermissionPolicy } from './permissionPolicy';

function exposeClaudeExecutionRunHostRuntime(runtime: ClaudeSdkAgentBackend): ExecutionRunHostRuntime {
  return Object.freeze({
    readResumeSupport: runtime.readResumeSupport.bind(runtime),
    provisionSession: runtime.provisionSession.bind(runtime),
    sendPrompt: runtime.sendPrompt.bind(runtime),
    sendSteerPrompt: runtime.sendSteerPrompt.bind(runtime),
    cancel: runtime.cancel.bind(runtime),
    subscribeMessages: runtime.subscribeMessages.bind(runtime),
    respondToPermission: runtime.respondToPermission.bind(runtime),
    waitForTurnCompletion: runtime.waitForTurnCompletion.bind(runtime),
    dispose: runtime.dispose.bind(runtime),
  });
}

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  const runtime = new ClaudeSdkAgentBackend({
    cwd: opts.cwd,
    modelId: opts.modelId ?? 'default',
    permissionPolicy: resolvePermissionPolicy(opts.permissionMode),
    settingsPath: opts.isolation?.settingsPath,
    env: opts.isolation?.env,
  });
  return exposeClaudeExecutionRunHostRuntime(runtime);
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

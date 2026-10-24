import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/runtime/isolation/types';
import { configuration } from '@/configuration';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveClaudeSessionEnvOverlay } from '../spawn/resolveClaudeSessionEnvOverlay';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return new ClaudeSdkAgentBackend({
    cwd: opts.cwd,
    modelId: opts.modelId ?? 'default',
    permissionHandler: opts.permissionHandler,
    settingsPath: opts.isolation?.settingsPath,
    env: {
      ...opts.isolation?.env,
      ...resolveClaudeSessionEnvOverlay({ claudeCodeIncludeInNativeHistory: opts.accountSettings?.claudeCodeIncludeInNativeHistory === true }),
    },
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

  return {
    ...baseBundle,
    settingsPath,
    cleanup: async () => {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        await baseBundle.cleanup?.();
      }
    },
  };
}

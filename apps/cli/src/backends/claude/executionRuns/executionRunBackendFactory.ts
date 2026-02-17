import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/backends/isolation/types';
import { configuration } from '@/configuration';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return new ClaudeSdkAgentBackend({
    cwd: opts.cwd,
    modelId: opts.modelId ?? 'default',
    permissionPolicy: opts.permissionMode as any,
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
  return {
    ...baseBundle,
    settingsPath,
  };
}

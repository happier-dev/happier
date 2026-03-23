import { createOpenCodeBackend } from '@/backends/opencode/acp/backend';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createOpenCodeServerExecutionRunBackend } from './createOpenCodeServerExecutionRunBackend';

function normalizeOpenCodeBackendMode(value: unknown): 'server' | 'acp' {
  return value === 'acp' ? 'acp' : 'server';
}

function resolveOpenCodeExecutionRunBackendMode(args: Readonly<{
  env: NodeJS.ProcessEnv | undefined;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): 'server' | 'acp' {
  const raw = typeof args.env?.HAPPIER_OPENCODE_BACKEND_MODE === 'string'
    ? args.env.HAPPIER_OPENCODE_BACKEND_MODE.trim().toLowerCase()
    : '';
  if (raw === 'acp') return 'acp';
  if (args.accountSettings) {
    return normalizeOpenCodeBackendMode(args.accountSettings.opencodeBackendMode);
  }
  return 'server';
}

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  const env = opts.isolation?.env;
  const permissionMode = permissionModeForExecutionRunPolicy(opts.permissionMode);

  if (resolveOpenCodeExecutionRunBackendMode({ env, accountSettings: opts.accountSettings }) === 'acp') {
    return createOpenCodeBackend({
      cwd: opts.cwd,
      env,
      permissionHandler: opts.permissionHandler,
      permissionMode,
    });
  }

  return createOpenCodeServerExecutionRunBackend({
    cwd: opts.cwd,
    env,
    permissionHandler: opts.permissionHandler,
    permissionMode,
  });
};

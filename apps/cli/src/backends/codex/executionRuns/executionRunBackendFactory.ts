import { createCodexAcpBackend } from '@/backends/codex/acp/backend';
import { buildCodexAcpEnvOverrides } from '@/backends/codex/acp/env';
import { resolveCodexAcpSpawn } from '@/backends/codex/acp/resolveCommand';
import { validateCodexAcpSpawnAvailability } from '@/backends/codex/acp/spawnAvailability';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { resolveProviderSpawnExtrasForRuntime } from '@/settings/providerSettings';
import { createCodexAppServerExecutionRunBackend } from './createCodexAppServerExecutionRunBackend';
import { createCodexMcpExecutionRunBackend } from './createCodexMcpExecutionRunBackend';
import { probeCodexAppServerExecutionRunAvailability } from './probeCodexAppServerExecutionRunAvailability';
import { selectCodexExecutionRunTransport } from './selectCodexExecutionRunTransport';

function withProcessEnv<T>(overrides: NodeJS.ProcessEnv, run: () => T): T {
  const previous = process.env;
  process.env = { ...previous, ...overrides };
  try {
    return run();
  } finally {
    process.env = previous;
  }
}

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  const baseEnv = opts.isolation?.env;
  const env = buildCodexAcpEnvOverrides({ baseEnv, projectDir: opts.cwd });
  const permissionMode = permissionModeForExecutionRunPolicy(opts.permissionMode);
  const runtimeExtras = opts.accountSettings
    ? resolveProviderSpawnExtrasForRuntime({
        agentId: 'codex',
        settings: opts.accountSettings,
        processEnv: env,
      })
    : {};
  const preferredTransport = typeof env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT === 'string'
    ? env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT
    : typeof runtimeExtras.codexBackendMode === 'string'
      ? runtimeExtras.codexBackendMode
      : undefined;
  const transport = selectCodexExecutionRunTransport({
    hasInteractiveTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    preferredTransport,
    start: opts.start ?? null,
  });

  if (transport === 'appServer' && probeCodexAppServerExecutionRunAvailability({ env })) {
    return createCodexAppServerExecutionRunBackend({
      cwd: opts.cwd,
      env,
      permissionHandler: opts.permissionHandler,
      permissionMode,
    });
  }

  const shouldUseMcp = transport === 'mcp' || (() => {
    try {
      const spawnSpec = withProcessEnv(env, () => resolveCodexAcpSpawn({ permissionMode }));
      return !validateCodexAcpSpawnAvailability(spawnSpec, { env }).ok;
    } catch {
      return true;
    }
  })();

  if (shouldUseMcp) {
    return createCodexMcpExecutionRunBackend({
      cwd: opts.cwd,
      env,
      modelId: opts.modelId,
      permissionMode,
    });
  }

  return createCodexAcpBackend({
    cwd: opts.cwd,
    env,
    permissionHandler: opts.permissionHandler,
    permissionMode,
  }).backend;
};

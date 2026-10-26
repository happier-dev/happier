import { readSpawnConfigOptionOverrideValue, resolveCodexReasoningSummaryOverride } from '@happier-dev/protocol';

import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';
import { createCodexAcpBackend } from '@/backends/codex/acp/backend';
import { withExecutionRunBackendModelOptions } from '@/agent/executionRuns/runtime/applyExecutionRunBackendModelOptions';
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

const CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_CODEX_TUI_BIN',
  'HAPPY_CODEX_TUI_BIN',
  'HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT',
  'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
  'HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
  'HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS',
] as const;

function buildCodexExecutionRunBaseEnv(isolationEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (isolationEnv === undefined) return { ...process.env };

  const inherited: NodeJS.ProcessEnv = {};
  for (const key of CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      inherited[key] = value;
    }
  }

  if (Object.keys(inherited).length === 0) return isolationEnv;
  return {
    ...inherited,
    ...(isolationEnv ?? {}),
  };
}

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  // Reasoning effort uses the SAME canonical config-option vocabulary as session spawn
  // (`reasoning_effort`), read with the shared protocol reader — no second vocabulary.
  const reasoningEffortValue = readSpawnConfigOptionOverrideValue(
    opts.sessionConfigOptionOverrides,
    'reasoning_effort',
  );
  const reasoningEffort = readNonBlankSessionControlIdentifier(reasoningEffortValue) ?? undefined;
  const reasoningSummary = resolveCodexReasoningSummaryOverride(opts.accountSettings?.codexReasoningSummaries);
  const baseEnv = buildCodexExecutionRunBaseEnv(opts.isolation?.env);
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
    return withExecutionRunBackendModelOptions(
      createCodexAppServerExecutionRunBackend({
        cwd: opts.cwd,
        reasoningSummary,
        env,
        permissionHandler: opts.permissionHandler,
        permissionMode,
        start: opts.start ?? null,
      }),
      {
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        ...(opts.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
          : {}),
      },
    );
  }

  const shouldUseMcp = transport === 'mcp' || (() => {
    try {
      const spawnSpec = resolveCodexAcpSpawn({ permissionMode, env });
      return !validateCodexAcpSpawnAvailability(spawnSpec, { env }).ok;
    } catch {
      return true;
    }
  })();

  if (shouldUseMcp) {
    return createCodexMcpExecutionRunBackend({
      cwd: opts.cwd,
      reasoningSummary,
      env,
      modelId: opts.modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      permissionMode,
    });
  }

  return withExecutionRunBackendModelOptions(
    createCodexAcpBackend({
      cwd: opts.cwd,
      reasoningSummary,
      env,
      permissionHandler: opts.permissionHandler,
      permissionMode,
    }).backend,
    {
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
      ...(opts.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
        : {}),
    },
  );
};

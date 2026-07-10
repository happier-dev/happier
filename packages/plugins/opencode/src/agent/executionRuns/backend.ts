import {
  createExecutionRunHostBackendFromSessionRuntime,
  type CreateExecutionRunBackendParamsV1,
  type ExecutionRunBackendCreateResultV1,
  type ExecutionRunHostBackendV1,
  type PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { OPEN_CODE_ACP_BACKEND_SPEC } from '../acp/openCodeAcpBackendSpec.js';
import {
  readOpenCodeBackendModeInputFromRuntimeParams,
  resolveOpenCodeBackendMode,
} from '../runtime/mode.js';
import { createOpenCodeServerRuntimeAssembly } from '../runtime/server/assembly.js';
import { readOpenCodeServerEndpoint } from '../runtime/server/endpoint.js';
import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';

const OPENCODE_EXECUTION_RUN_STATUS_POLL_INTERVAL_MS = 10;

function readDirectory(executionRunParams: unknown): string {
  const record = asRecord(executionRunParams);
  return normalizeString(record?.cwd)
    || normalizeString(record?.directory)
    || process.cwd();
}

function readPermissionMode(executionRunParams: unknown): string | null {
  return normalizeString(asRecord(executionRunParams)?.permissionMode) || null;
}

function readModelId(executionRunParams: unknown): string | null {
  const modelId = normalizeString(asRecord(executionRunParams)?.modelId);
  return modelId && modelId !== 'default' ? modelId : null;
}

function createAcpExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  const acpEngine = params.ctx.agentRuntime.acp.defineAcpBackend(OPEN_CODE_ACP_BACKEND_SPEC);
  const createExecutionRunBackend = acpEngine.runtimeCore?.createExecutionRunBackend;
  if (typeof createExecutionRunBackend !== 'function') {
    throw new Error('OpenCode ACP backend definition did not expose runtimeCore.createExecutionRunBackend.');
  }
  return createExecutionRunBackend(params.executionRunParams);
}

function createOpenCodeServerExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const directory = readDirectory(params.executionRunParams);
  const endpoint = readOpenCodeServerEndpoint(params.ctx, params.executionRunParams);
  const permissionMode = readPermissionMode(params.executionRunParams);
  const modelId = readModelId(params.executionRunParams);
  const happierSessionId = normalizeString(asRecord(params.executionRunParams)?.runId) || 'opencode-execution-run';
  const environment = composeSessionIsolationEnvironment({
    inheritedEnvironment: params.ctx.env.list(),
    isolationEnvironment: params.executionRunParams.isolation?.env,
    environment: params.executionRunParams.env,
    unsetEnvKeys: params.executionRunParams.isolation?.unsetEnvKeys,
  });

  return createExecutionRunHostBackendFromSessionRuntime({
    createSessionRuntime: async (runtimeParams) => {
      const assembly = await createOpenCodeServerRuntimeAssembly({
        ctx: params.ctx,
        directory,
        happierSessionId,
        endpoint,
        env: environment,
        permissionMode,
        ...(runtimeParams?.resumeSessionId ? { resumeSessionId: runtimeParams.resumeSessionId } : {}),
      });
      if (modelId) await assembly.runtime.updateConfig?.({ modelId });
      return assembly.runtime;
    },
    supportsSteerPrompt: false,
    waitForTurnCompletion: {
      mode: 'untilIdle',
      pollIntervalMs: OPENCODE_EXECUTION_RUN_STATUS_POLL_INTERVAL_MS,
    },
    diagnostics: {
      source: 'opencode-server-runtime',
    },
  });
}

export function createOpenCodeExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  const mode = resolveOpenCodeBackendMode(
    readOpenCodeBackendModeInputFromRuntimeParams(params.executionRunParams),
  );
  if (mode === 'acp') {
    return createAcpExecutionRunBackend(params);
  }
  return createOpenCodeServerExecutionRunBackend(params);
}

import type {
  CreateExecutionRunBackendParamsV1,
  ExecutionRunBackendCreateResultV1,
  ExecutionRunHostBackendV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromTurnOperations } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';
import type { InternalRuntimeTurnOperationsV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { OPEN_CODE_ACP_BACKEND_SPEC } from '../acp/openCodeAcpBackendSpec.js';
import {
  readOpenCodeBackendModeInputFromRuntimeParams,
  resolveOpenCodeBackendMode,
} from '../runtime/mode.js';
import { createOpenCodeServerRuntimeAssembly } from '../runtime/server/assembly.js';
import { asRecord, normalizeString, readStringRecord } from '../runtime/server/openCodeParsing.js';

const DEFAULT_OPENCODE_SERVER_BASE_URL = 'http://127.0.0.1:4096';
const OPENCODE_EXECUTION_RUN_STATUS_POLL_INTERVAL_MS = 10;

function readDirectory(executionRunParams: unknown): string {
  const record = asRecord(executionRunParams);
  return normalizeString(record?.cwd)
    || normalizeString(record?.directory)
    || process.cwd();
}

function readBaseUrl(ctx: PluginContextV1, executionRunParams: unknown): string {
  const record = asRecord(executionRunParams);
  const env = readStringRecord(asRecord(record?.isolation)?.env ?? record?.env);
  return normalizeString(env.HAPPIER_OPENCODE_SERVER_URL)
    || normalizeString(ctx.config?.values?.HAPPIER_OPENCODE_SERVER_URL)
    || DEFAULT_OPENCODE_SERVER_BASE_URL;
}

function createAcpExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  const acpEngine = params.ctx.acp.defineAcpBackend(OPEN_CODE_ACP_BACKEND_SPEC);
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
  const baseUrl = readBaseUrl(params.ctx, params.executionRunParams);
  const happierSessionId = normalizeString(asRecord(params.executionRunParams)?.runId) || 'opencode-execution-run';

  return createExecutionRunHostBackendFromTurnOperations({
    createOperations: async () => {
      const assembly = await createOpenCodeServerRuntimeAssembly({
        ctx: params.ctx,
        directory,
        happierSessionId,
        baseUrl,
      });
      return assembly.runtime as unknown as InternalRuntimeTurnOperationsV1;
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

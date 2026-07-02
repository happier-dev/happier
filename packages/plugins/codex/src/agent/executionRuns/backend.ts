import type {
  CreateExecutionRunBackendParamsV1,
  ExecutionRunBackendCreateResultV1,
  ExecutionRunHostBackendV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromTurnOperations } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';

import {
  createCodexAppServerRuntime,
  type CodexAppServerRuntime,
} from '../runtime/appServer/runtime.js';

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDirectory(params: CreateExecutionRunBackendParamsV1): string {
  return normalizeString(params.cwd) ?? normalizeString(params.directory) ?? process.cwd();
}

function readProcessEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> {
  return {
    ...(params.isolation?.env ?? {}),
    ...(params.env ?? {}),
  };
}

export function createCodexAppServerExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const directory = readDirectory(params.executionRunParams);
  const happierSessionId = normalizeString(params.executionRunParams.runId) ?? 'codex-execution-run';

  return createExecutionRunHostBackendFromTurnOperations({
    createOperations: () => createCodexAppServerRuntime({
      ctx: params.ctx,
      directory,
      happierSessionId,
      processEnv: readProcessEnv(params.executionRunParams),
    }),
    readRuntimeLiveness: (operations) => {
      const runtime = operations as CodexAppServerRuntime;
      return typeof runtime.probeTurnLiveness === 'function'
        ? runtime.probeTurnLiveness()
        : null;
    },
    diagnostics: {
      source: 'codex-app-server-runtime',
    },
  });
}

export function createCodexExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  return createCodexAppServerExecutionRunBackend(params);
}

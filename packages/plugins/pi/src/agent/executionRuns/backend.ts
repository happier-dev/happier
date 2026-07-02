import type {
  CreateExecutionRunBackendParamsV1,
  ExecutionRunHostBackendV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromTurnOperations } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';

import { createPiRuntimeOperations } from '../runtime/rpc/operations.js';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> {
  const env = params.isolation?.env ?? params.env ?? {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readDirectory(params: CreateExecutionRunBackendParamsV1): string {
  return readString(params.cwd)
    ?? readString(params.directory)
    ?? process.cwd();
}

function readRunSessionId(params: CreateExecutionRunBackendParamsV1): string {
  return readString(params.runId) ?? 'pi-execution-run';
}

export function createPiExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const directory = readDirectory(params.executionRunParams);
  const env = readEnv(params.executionRunParams);
  const happierSessionId = readRunSessionId(params.executionRunParams);
  const permissionMode = readString(params.executionRunParams.permissionMode) ?? undefined;

  return createExecutionRunHostBackendFromTurnOperations({
    createOperations: () => createPiRuntimeOperations({
      ctx: params.ctx,
      cwd: directory,
      env,
      permissionMode,
      happierSessionId,
    }),
    diagnostics: {
      source: 'pi-strict-lf-json-runtime',
    },
  });
}

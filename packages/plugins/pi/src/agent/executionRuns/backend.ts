import {
  createExecutionRunHostBackendFromSessionRuntime,
  type CreateExecutionRunBackendParamsV1,
  type ExecutionRunHostBackendV1,
  type PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createPiRuntimeOperations } from '../runtime/rpc/operations.js';

const PI_EXECUTION_RUN_COMPLETION_POLL_INTERVAL_MS = 10;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> {
  const env = composeSessionIsolationEnvironment({
    isolationEnvironment: params.isolation?.env,
    environment: params.env,
    unsetEnvKeys: params.isolation?.unsetEnvKeys,
  });
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

function readModelId(params: CreateExecutionRunBackendParamsV1): string | null {
  const modelId = readString(params.modelId);
  return modelId && modelId !== 'default' ? modelId : null;
}

export function createPiExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const directory = readDirectory(params.executionRunParams);
  const env = readEnv(params.executionRunParams);
  const happierSessionId = readRunSessionId(params.executionRunParams);
  const permissionMode = readString(params.executionRunParams.permissionMode) ?? undefined;
  const modelId = readModelId(params.executionRunParams);

  return createExecutionRunHostBackendFromSessionRuntime({
    createSessionRuntime: async (factoryParams) => {
      const runtime = await createPiRuntimeOperations({
        ctx: params.ctx,
        cwd: directory,
        env,
        permissionMode,
        resumeSessionId: readString(factoryParams?.resumeSessionId),
        happierSessionId,
        eagerStart: true,
      });
      if (modelId) await runtime.updateConfig?.({ modelId });
      return runtime;
    },
    waitForTurnCompletion: {
      mode: 'untilIdle',
      pollIntervalMs: PI_EXECUTION_RUN_COMPLETION_POLL_INTERVAL_MS,
    },
    diagnostics: {
      source: 'pi-strict-lf-json-runtime',
    },
  });
}

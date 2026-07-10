import {
  createExecutionRunHostBackendFromSessionRuntime,
  type CreateExecutionRunHostBackendFromSessionRuntimeOptionsV1,
  type CreateExecutionRunBackendParamsV1,
  type ExecutionRunBackendCreateResultV1,
  type ExecutionRunHostBackendV1,
  type PluginContextV1,
  type SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import {
  type CodexAppServerRuntime,
} from '../runtime/appServer/runtime.js';
import { createCodexAppServerSessionRuntime } from '../runtime/appServer/session.js';

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDirectory(params: CreateExecutionRunBackendParamsV1): string {
  return normalizeString(params.cwd) ?? normalizeString(params.directory) ?? process.cwd();
}

function readProcessEnv(
  ctx: PluginContextV1,
  params: CreateExecutionRunBackendParamsV1,
): Readonly<Record<string, string>> {
  return composeSessionIsolationEnvironment({
    inheritedEnvironment: ctx.env.list(),
    isolationEnvironment: params.isolation?.env,
    environment: params.env,
    unsetEnvKeys: params.isolation?.unsetEnvKeys,
  });
}

function readModelId(params: CreateExecutionRunBackendParamsV1): string | null {
  const modelId = normalizeString(params.modelId);
  return modelId && modelId !== 'default' ? modelId : null;
}

function hasCodexAppServerLivenessProbe(runtime: SessionRuntimeV1): runtime is CodexAppServerRuntime {
  return typeof (runtime as SessionRuntimeV1 & Readonly<{ probeTurnLiveness?: unknown }>).probeTurnLiveness === 'function';
}

function readCodexExecutionRunMessageActivity(
  message: Parameters<NonNullable<CreateExecutionRunHostBackendFromSessionRuntimeOptionsV1['readMessageActivity']>>[0],
): ReturnType<NonNullable<CreateExecutionRunHostBackendFromSessionRuntimeOptionsV1['readMessageActivity']>> {
  if ('kind' in message && message.kind === 'backend-error') return 'idle';
  return null;
}

export function createCodexAppServerExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const directory = readDirectory(params.executionRunParams);
  const happierSessionId = normalizeString(params.executionRunParams.runId) ?? 'codex-execution-run';
  const modelId = readModelId(params.executionRunParams);
  const processEnv = readProcessEnv(params.ctx, params.executionRunParams);

  return createExecutionRunHostBackendFromSessionRuntime({
    createSessionRuntime: (factoryParams) => createCodexAppServerSessionRuntime({
      ctx: params.ctx,
      sessionParams: {
        backendId: params.executionRunParams.backendId ?? 'codex',
        cwd: directory,
        directory,
        sessionId: happierSessionId,
        ...(modelId ? { modelId } : {}),
        env: processEnv,
        initialRuntimeState: {
          ...(factoryParams?.resumeSessionId ? { providerSessionId: factoryParams.resumeSessionId } : {}),
          ...(factoryParams?.captureReplay === true ? { captureReplay: true } : {}),
        },
      },
    }),
    readRuntimeLiveness: (runtime) => hasCodexAppServerLivenessProbe(runtime)
      ? runtime.probeTurnLiveness()
      : null,
    readMessageActivity: readCodexExecutionRunMessageActivity,
    waitForTurnCompletion: { mode: 'untilIdle' },
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

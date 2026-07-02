import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type { TailscaleEnsureReadyTaskResult } from '@happier-dev/protocol';

import {
  createTailscaleReadinessRuntimeDeps,
  inspectLocalTailscaleReadinessState,
  runTailscaleReadinessFlow,
  type TailscaleReadinessBaseParams,
  type TailscaleReadinessInspectionOptions,
  type TailscaleReadinessRuntimeDeps,
  type TailscaleReadinessState,
} from './tailscaleReadinessFlow.js';

type TailscaleEnsureReadyParams = TailscaleReadinessBaseParams;

type TailscaleEnsureReadyDeps = TailscaleReadinessRuntimeDeps & Readonly<{
  inspectState: (params: TailscaleEnsureReadyParams, options?: TailscaleReadinessInspectionOptions) => Promise<TailscaleReadinessState>;
}>;

export function createTailscaleEnsureReadyHandler(overrides?: Partial<TailscaleEnsureReadyDeps>) {
  const deps = createTailscaleEnsureReadyDeps(overrides);

  return async function* (
    params: unknown,
    context?: Readonly<{ signal?: AbortSignal }>,
  ): AsyncGenerator<
    Readonly<{
      type: 'progress' | 'prompt';
      stepId: string;
      message?: string;
      data?: Record<string, string | boolean>;
    }>,
    TailscaleEnsureReadyTaskResult,
    void
  > {
    const parsed = parseTailscaleEnsureReadyParams(params);
    const state = yield* runTailscaleReadinessFlow(parsed, deps, context);
    return {
      tailscaleInstalled: state.installed,
      tailscaleLoggedIn: state.loggedIn,
      authUrl: state.authUrl,
    };
  };
}

function createTailscaleEnsureReadyDeps(overrides?: Partial<TailscaleEnsureReadyDeps>): TailscaleEnsureReadyDeps {
  return {
    ...createTailscaleReadinessRuntimeDeps(overrides),
    inspectState: overrides?.inspectState ?? (async (_params, options) => await inspectLocalTailscaleReadinessState(options)),
  };
}

function parseTailscaleEnsureReadyParams(params: unknown): TailscaleEnsureReadyParams {
  if (params == null) {
    return {
      installPolicy: 'skip',
      loginPolicy: 'interactive',
      mode: 'normalUser',
    };
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      'Expected tailscale ensure-ready params to be an object.',
    );
  }

  const record = params as Record<string, unknown>;
  const allowedKeys = new Set(['installPolicy', 'loginPolicy', 'mode']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new systemTasks.SystemTaskExecutionError(
        'invalid_params',
        `Unknown tailscale ensure-ready param: ${key}`,
      );
    }
  }

  return {
    installPolicy: record.installPolicy === 'installIfMissing' ? 'installIfMissing' : 'skip',
    loginPolicy: record.loginPolicy === 'skip' ? 'skip' : 'interactive',
    mode: record.mode === 'managedAdmin' ? 'managedAdmin' : 'normalUser',
  };
}

import type {
  AgentRuntimeV1,
  CreateExecutionRunBackendParamsV1,
  CreateSessionRuntimeParamsV1,
  ExecutionRunBackendCreateResultV1,
  PluginContextV1,
  SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';

import { createOpenCodeExecutionRunBackend } from '../executionRuns/backend.js';
import { createOpenCodeAcpSessionRuntime } from './acp/session.js';
import type { OpenCodeBackendMode } from './mode.js';
import {
  readOpenCodeBackendModeInputFromRuntimeParams,
  resolveOpenCodeBackendMode,
} from './mode.js';
import { createOpenCodeServerSessionRuntime } from './server/session.js';
import { openCodeExternalSessionSurface } from '../surfaces/sessions/external/provider.js';
import { createOpenCodeHandoffSurface } from '../surfaces/sessions/handoff/descriptor.js';
import { openCodeForkSurface } from '../surfaces/sessions/fork/descriptor.js';

export type OpenCodeSessionRuntimeFactory = (
  params: Readonly<{
    ctx: PluginContextV1;
    sessionParams: CreateSessionRuntimeParamsV1;
  }>,
) => SessionRuntimeCreateResultV1 | Promise<SessionRuntimeCreateResultV1>;

export type OpenCodeExecutionRunBackendFactory = (
  params: Readonly<{
    ctx: PluginContextV1;
    mode: OpenCodeBackendMode;
    executionRunParams: CreateExecutionRunBackendParamsV1;
  }>,
) => ExecutionRunBackendCreateResultV1;

export type CreateOpenCodeBackendEngineOptions = Readonly<{
  sessionRuntimes?: Partial<Record<OpenCodeBackendMode, OpenCodeSessionRuntimeFactory>>;
  executionRuns?: OpenCodeExecutionRunBackendFactory;
}>;

export function createOpenCodeBackendEngine(
  ctx: PluginContextV1,
  options: CreateOpenCodeBackendEngineOptions = {},
): AgentRuntimeV1 {
  const createServerSessionRuntime =
    options.sessionRuntimes?.server ?? createOpenCodeServerSessionRuntime;
  const createAcpSessionRuntime =
    options.sessionRuntimes?.acp ?? createOpenCodeAcpSessionRuntime;
  const createExecutionRunBackend =
    options.executionRuns ?? ((params) => createOpenCodeExecutionRunBackend({
      ctx: params.ctx,
      executionRunParams: params.executionRunParams,
    }));

  return {
    externalSessionSurface: openCodeExternalSessionSurface,
    handoffSurface: createOpenCodeHandoffSurface(ctx),
    forkSurface: openCodeForkSurface,
    runtimeCore: {
      createSessionRuntime: async (sessionParams) => {
        const mode = resolveOpenCodeBackendMode(
          readOpenCodeBackendModeInputFromRuntimeParams(sessionParams),
        );
        const createSessionRuntime = mode === 'acp' ? createAcpSessionRuntime : createServerSessionRuntime;
        return createSessionRuntime({ ctx, sessionParams });
      },
      createExecutionRunBackend: (executionRunParams) => {
        const mode = resolveOpenCodeBackendMode(
          readOpenCodeBackendModeInputFromRuntimeParams(executionRunParams),
        );
        return createExecutionRunBackend({ ctx, mode, executionRunParams });
      },
    },
  };
}

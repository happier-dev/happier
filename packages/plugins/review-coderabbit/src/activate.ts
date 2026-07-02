import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  PluginDisposable,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';

import { createCodeRabbitExecutionRunBackend } from './agent/reviews/run.js';

type CodeRabbitPluginApiV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: CodeRabbitPluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'coderabbit',
    create: (ctx: PluginContextV1) => ({
      runtimeCore: {
        createSessionRuntime: async (_sessionParams: CreateSessionRuntimeParamsV1) => {
          throw new Error('CodeRabbit is a review-only execution-run plugin and does not support sessions.');
        },
        createExecutionRunBackend: (executionRunParams) => createCodeRabbitExecutionRunBackend({
          ctx,
          executionRunParams,
        }),
      },
    }),
  });
}

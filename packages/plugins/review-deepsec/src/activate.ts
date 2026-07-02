import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  PluginDisposable,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';

import { createDeepSecExecutionRunBackend } from './agent/reviews/execution.js';

type DeepSecPluginApiV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: DeepSecPluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'deepsec',
    create: (ctx: PluginContextV1) => ({
      runtimeCore: {
        createSessionRuntime: async (_sessionParams: CreateSessionRuntimeParamsV1) => {
          throw new Error('DeepSec is a review-only execution-run plugin and does not support sessions.');
        },
        createExecutionRunBackend: (executionRunParams) => createDeepSecExecutionRunBackend({
          ctx,
          executionRunParams,
        }),
      },
    }),
  });
}

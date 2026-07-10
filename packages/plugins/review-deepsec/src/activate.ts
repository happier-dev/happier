import type {
  PluginApi,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createDeepSecExecutionRunBackend } from './agent/reviews/execution.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'deepsec',
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

import type {
  PluginApi,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createCodeRabbitExecutionRunBackend } from './agent/reviews/run.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'coderabbit',
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

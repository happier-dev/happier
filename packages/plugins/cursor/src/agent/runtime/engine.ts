import type {
  AgentRuntimeV1,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createCursorAcpRuntimeConnection } from '../acp/connection.js';

export function createCursorBackendEngine(ctx: PluginContextV1): AgentRuntimeV1 {
  return {
    runtimeCore: {
      createSessionRuntime: async (sessionParams: CreateSessionRuntimeParamsV1) => {
        return createCursorAcpRuntimeConnection({ ctx, sessionParams });
      },
      createExecutionRunBackend: () => {
        throw new Error('Cursor is a session backend in v1 and does not support execution runs.');
      },
    },
  };
}

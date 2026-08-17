import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { openCursorAcpSession } from '../acp/connection.js';

export const createCursorAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return openCursorAcpSession(request, context);
    },
  },
});

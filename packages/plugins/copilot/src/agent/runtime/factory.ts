import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCopilotAcpArgv } from '../acp/callbacks.js';
import { COPILOT_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';

export const createCopilotAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      if (!request.configuration) {
        throw new Error('Copilot requires the host-projected Agent session configuration');
      }
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'copilot-cli' },
          args: buildCopilotAcpArgv({
            baseArgs: ['--acp'],
            permissionIntent: request.configuration.permissionIntent.value,
          }),
        },
        definition: COPILOT_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

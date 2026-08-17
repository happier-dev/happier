import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildAuggieAcpArgvFromSessionConfiguration } from '../acp/callbacks.js';
import { AUGGIE_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';

export const createAuggieAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      if (!request.configuration) {
        throw new Error('Auggie requires the host-projected Agent session configuration');
      }
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'auggie-cli' },
          args: buildAuggieAcpArgvFromSessionConfiguration({
            baseArgs: ['--acp'],
            configuration: request.configuration,
          }),
        },
        definition: AUGGIE_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

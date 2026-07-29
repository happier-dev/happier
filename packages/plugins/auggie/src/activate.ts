import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { buildAuggieAcpArgvFromSessionConfiguration } from './agent/acp/callbacks.js';
import { AUGGIE_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';

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

export function activate(api: PluginApi): void {
  api.agents.register('auggie', createAuggieAgentRuntime);
}

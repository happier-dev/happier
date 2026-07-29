import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { KIRO_ACP_RUNTIME_DEFINITION } from './agent/acp/runtimeDefinition.js';

export const createKiroAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'kiro-cli' },
          args: ['acp'],
        },
        definition: KIRO_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

export function activate(api: PluginApi): void {
  api.agents.register('kiro', createKiroAgentRuntime);
}

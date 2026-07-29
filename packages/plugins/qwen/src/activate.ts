import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { buildQwenAcpArgv } from './agent/acp/approvalMode.js';
import { QWEN_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';

export const createQwenAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      if (!request.configuration) {
        throw new Error('Qwen requires the host-projected Agent session configuration');
      }
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'qwen-cli' },
          args: buildQwenAcpArgv({
            baseArgs: ['--acp'],
            permissionIntent: request.configuration.permissionIntent.value,
          }),
        },
        definition: QWEN_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

export function activate(api: PluginApi): void {
  api.agents.register('qwen', createQwenAgentRuntime);
}

import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { buildKiloAcpEnv } from './agent/acp/callbacks.js';
import { KILO_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';

export const createKiloAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      if (!request.configuration) {
        throw new Error('Kilo requires the host-projected Agent session configuration');
      }
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'kilo-cli' },
          args: ['acp'],
          env: buildKiloAcpEnv({
            launchEnvironment: request.launchEnvironment,
            permissionIntent: request.configuration.permissionIntent.value,
          }),
        },
        definition: KILO_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

export function activate(api: PluginApi): void {
  api.agents.register('kilo', createKiloAgentRuntime);
}

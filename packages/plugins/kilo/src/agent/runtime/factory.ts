import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKiloAcpEnv } from '../acp/callbacks.js';
import { KILO_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';

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

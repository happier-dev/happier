import type {
  AgentAcpRuntimeDefinition,
  AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { OH_MY_PI_SYSTEM_TOOL_ID } from '../systemTool.js';

const OH_MY_PI_ACP_RUNTIME_DEFINITION = Object.freeze({
  acceptsVerifiedImageInput: true,
  modelConfigOptionId: 'model',
  mcp: { policy: 'pass_through' as const },
}) satisfies AgentAcpRuntimeDefinition;

export const createOhMyPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: {
            kind: 'systemTool',
            id: OH_MY_PI_SYSTEM_TOOL_ID,
          },
          args: ['--mode', 'acp'],
        },
        definition: OH_MY_PI_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});

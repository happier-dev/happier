import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { GROK_ACP_COMMAND } from '../preflight/models.js';

import {
  buildGrokAcpRuntimeDefinition,
  createGrokAcpRuntimeExtensions,
} from '../acp/definition.js';

export const createGrokAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request, context) {
      return await context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: GROK_ACP_COMMAND.toolId },
          args: [...GROK_ACP_COMMAND.args],
        },
        definition: buildGrokAcpRuntimeDefinition(request.launchEnvironment?.values ?? {}),
        extensions: createGrokAcpRuntimeExtensions(context),
      });
    },
    executionRunContextV1: {
      async open(request, context) {
        return await context.protocols.acp.openExecutionRunV1(request, {
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: GROK_ACP_COMMAND.toolId },
            args: [...GROK_ACP_COMMAND.args],
          },
          definition: buildGrokAcpRuntimeDefinition(request.launchEnvironment?.values ?? {}),
        });
      },
    },
  },
});

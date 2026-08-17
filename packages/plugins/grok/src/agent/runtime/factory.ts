import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

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
          executable: { kind: 'systemTool', id: 'grok-cli' },
          args: ['--no-auto-update', 'agent', 'stdio'],
        },
        definition: buildGrokAcpRuntimeDefinition(request.launchEnvironment?.values ?? {}),
        extensions: createGrokAcpRuntimeExtensions(context),
      });
    },
  },
});

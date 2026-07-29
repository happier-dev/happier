import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  buildGrokAcpRuntimeDefinition,
  createGrokAcpRuntimeExtensions,
} from './agent/acp/definition.js';

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

export function activate(api: PluginApi): void {
  api.agents.register('grok', createGrokAgentRuntime);
}

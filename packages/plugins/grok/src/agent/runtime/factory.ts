import type { AgentRuntimeFactory, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';

export { grokExternalSessionsContribution } from '../externalSessions/contribution.js';

import { GROK_ACP_COMMAND } from '../preflight/models.js';

import {
  buildGrokAcpRuntimeDefinition,
  createGrokAcpRuntimeExtensions,
} from '../acp/definition.js';

function buildGrokSkillArgs(skills: AgentSessionSkillDelivery | undefined): string[] {
  if (!skills) return [...GROK_ACP_COMMAND.args];
  // The plugin directory is an `agent` option, before the stdio subcommand.
  return [...GROK_ACP_COMMAND.args.slice(0, -1), '--plugin-dir', skills.pluginRoot, 'stdio'];
}

export const createGrokAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request, context) {
      return await context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: GROK_ACP_COMMAND.toolId },
          args: buildGrokSkillArgs(request.skills),
        },
        definition: buildGrokAcpRuntimeDefinition(request.launchEnvironment?.values ?? {}, request.providerBinding),
        extensions: createGrokAcpRuntimeExtensions(context),
      });
    },
    executionRunContextV1: {
      async open(request, context) {
        return await context.protocols.acp.openExecutionRunV1(request, {
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: GROK_ACP_COMMAND.toolId },
            args: buildGrokSkillArgs(request.skills),
          },
          definition: buildGrokAcpRuntimeDefinition(request.launchEnvironment?.values ?? {}, request.providerBinding),
        });
      },
    },
  },
});

import type {
  AgentAcpRuntimeOptions,
  AgentRuntimeFactory,
  AgentSessionConfigurationSnapshot,
  AgentSessionSkillDelivery,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildAuggieAcpArgvFromSessionConfiguration } from '../acp/callbacks.js';
import { AUGGIE_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { AUGGIE_ACP_COMMAND } from '../preflight/models.js';
export { auggieExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

function createAuggieAcpOptions(configuration: AgentSessionConfigurationSnapshot | undefined, skills?: AgentSessionSkillDelivery): AgentAcpRuntimeOptions {
  if (!configuration) throw new Error('Auggie requires the host-projected Agent session configuration');
  return {
    transport: {
      kind: 'stdio',
      executable: { kind: 'systemTool', id: AUGGIE_ACP_COMMAND.toolId },
      args: buildAuggieAcpArgvFromSessionConfiguration({
        baseArgs: [...AUGGIE_ACP_COMMAND.args],
        configuration,
        pluginRoot: skills?.pluginRoot,
      }),
    },
    definition: { ...AUGGIE_ACP_RUNTIME_DEFINITION,
      toolNameResolver: ({ toolName, input }) => {
        const name = toolName.trim().toLowerCase();
        const acp = input._acp;
        return (name === 'unknown tool' || name === 'unknown' || name === 'other')
          && acp && typeof acp === 'object' && 'title' in acp && acp.title === 'Workspace Indexing Permission'
          ? 'WorkspaceIndexingPermission' : null;
      },
    },
  };
}

export const createAuggieAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request, context) {
      const runtime = await context.protocols.acp.open(request, createAuggieAcpOptions(request.configuration, request.skills));
      // This custom launch leaf, not the declarative composer, supplied the native carrier.
      return request.skills ? { ...runtime, skillsDelivered: true } : runtime;
    },
    executionRunContextV1: {
      open: (request, context) => context.protocols.acp.openExecutionRunV1(
        request,
        createAuggieAcpOptions(request.configuration, request.skills),
      ),
    },
  },
});

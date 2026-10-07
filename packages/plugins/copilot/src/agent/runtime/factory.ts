import type {
  AgentAcpRuntimeOptions,
  AgentRuntimeFactory,
  AgentSessionConfigurationSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCopilotAcpArgv } from '../acp/callbacks.js';
import { COPILOT_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { COPILOT_ACP_COMMAND } from '../acp/preflight.js';

function createCopilotAcpOptions(configuration: AgentSessionConfigurationSnapshot | undefined): AgentAcpRuntimeOptions {
  if (!configuration) throw new Error('Copilot requires the host-projected Agent session configuration');
  return {
    transport: {
      kind: 'stdio',
      executable: { kind: 'systemTool', id: COPILOT_ACP_COMMAND.toolId },
      args: buildCopilotAcpArgv({
        baseArgs: [...COPILOT_ACP_COMMAND.args],
        permissionIntent: configuration.permissionIntent.value,
      }),
    },
    definition: COPILOT_ACP_RUNTIME_DEFINITION,
  };
}

export const createCopilotAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return context.protocols.acp.open(request, createCopilotAcpOptions(request.configuration));
    },
    executionRunContextV1: {
      open: (request, context) => context.protocols.acp.openExecutionRunV1(
        request,
        createCopilotAcpOptions(request.configuration),
      ),
    },
  },
});

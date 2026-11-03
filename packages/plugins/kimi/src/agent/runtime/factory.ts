import type { AgentAcpRuntimeOptions, AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { KIMI_ACP_COMMAND } from '../acp/preflight.js';
import { createKimiWireSource } from '../acp/wireSource.js';
import { KIMI_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
export { kimiExternalSessionsContribution } from '../externalSessions/contribution.js';

const options: AgentAcpRuntimeOptions = {
  transport: {
    kind: 'stdio', executable: { kind: 'systemTool', id: KIMI_ACP_COMMAND.toolId },
    args: [...KIMI_ACP_COMMAND.args],
    timeouts: { initializeMs: 90_000, idleMs: 500, toolCallMs: 120_000 },
  },
  initialSessionModeId: 'default',
  disableSessionModeUpdates: true,
  providerTurnSource: createKimiWireSource(),
  definition: {
    modelConfigOptionId: 'model', mcp: { policy: 'pass_through' },
    stderrRules: { authenticationErrorDetail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.' },
  },
};

export const createKimiAgentRuntime: AgentRuntimeFactory = () => ({
  surfaces: { terminal: KIMI_TERMINAL_CONTRIBUTION },
  sessions: {
    open(request, context) {
      return context.protocols.acp.open(request, options);
    },
    executionRunContextV1: {
      open: (request, context) => context.protocols.acp.openExecutionRunV1(request, options),
    },
  },
});

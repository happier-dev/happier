import type {
  AgentAcpRuntimeOptions,
  AgentRuntimeFactory,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentExecutionRunRuntime,
  AgentExecutionRunConversationRuntimeV1,
  AgentExecutionRunOpenRequest,
  AgentSessionOpenRequest,
  AgentRuntimeContext,
  AgentSessionDisposeReason,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import { buildCopilotAcpArgv } from '../acp/callbacks.js';
import { COPILOT_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { COPILOT_ACP_COMMAND } from '../acp/preflight.js';
import { prepareCopilotConnectedAccount } from './connectedAccount.js';

export { copilotExternalSessionsContribution } from '../externalSessions/contribution.js';

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
      return openCopilot(request, context, (prepared, options) => context.protocols.acp.open(prepared, options));
    },
    executionRunContextV1: {
      open(request, context) {
        return openCopilot(request, context, (prepared, options) => context.protocols.acp.openExecutionRunV1(prepared, options));
      },
      async openConversation(request, context) {
        if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({
          code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.',
        });
        const open = context.protocols.acp.openExecutionRunConversationV1;
        return openCopilot(request, context, (prepared, options) => open(prepared, options));
      },
    },
  },
});

async function openCopilot<
  TRequest extends AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  TRuntime extends AgentSessionRuntime | AgentExecutionRunRuntime | AgentExecutionRunConversationRuntimeV1,
>(request: TRequest, context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
  open: (request: TRequest, options: AgentAcpRuntimeOptions) => TRuntime | Promise<TRuntime>,
): Promise<TRuntime> {
  const prepared = await prepareCopilotConnectedAccount(request, context);
  try {
    const options = createCopilotAcpOptions(request.configuration);
    const runtime = await open(prepared.request, prepared.models
      ? { ...options, definition: { ...options.definition, models: prepared.models } } : options);
    if (!prepared.models) return runtime;
    // ACP returns frozen closure handles. Preserve their live getter descriptors.
    return Object.create(Object.getPrototypeOf(runtime), {
      ...Object.getOwnPropertyDescriptors(runtime),
      dispose: { enumerable: true, value: async (reason?: AgentSessionDisposeReason) => {
        try { await runtime.dispose(reason); } finally { prepared.dispose(); }
      } },
    }) as TRuntime;
  } catch (error) { prepared.dispose(); throw error; }
}

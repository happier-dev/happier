import { PluginError } from '@happier-dev/plugin-sdk';
import {
  createExecutionRunHostBackendFromConversationRuntime,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentExecutionRunRuntimeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import { readOpenCodeServerEndpoint } from './endpoint.js';
import { createOpenCodeRuntimeContext } from './runtimeContext.js';

export async function openOpenCodeServerExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind === 'fork') {
    throw new PluginError({
      code: 'opencode_execution_run_fork_unsupported',
      message: 'OpenCode detached execution cannot fork without a provider-native checkpoint.',
    });
  }
  const runtimeContext = createOpenCodeRuntimeContext(request, context);
  const env = request.launchEnvironment?.values ?? {};
  const runtime = await createExecutionRunHostBackendFromConversationRuntime({
    request,
    openConversation: async () => {
      const assembly = await createOpenCodeServerRuntimeAssembly({
        ctx: runtimeContext,
        directory: request.cwd,
        executionRunId: request.runId,
        finiteExecutionRun: true,
        endpoint: readOpenCodeServerEndpoint(runtimeContext, { env, configuration: request.configuration }),
        env,
        permissionMode: request.configuration?.permissionIntent.value ?? null,
        mcpServers: request.mcpServers,
        mcpService: context.executionRun.services.mcp,
        request,
        signal: context.signal,
      });
      return assembly.runtime;
    },
    readCheckpointId: (event) => event.kind === 'provider-session-id'
      ? event.providerSessionId
      : null,
  });
  return { ...runtime, ...(request.skills ? { skillsDelivered: false } : {}) };
}

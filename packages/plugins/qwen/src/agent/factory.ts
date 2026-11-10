import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentRuntimeFactory, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { QWEN_ACP_RUNTIME_DEFINITION } from './acp/definition.js';
import { QWEN_ACP_COMMAND } from './acp/preflight.js';
import { prepareQwenConnectedAccount } from './connectedAccount.js';
export { qwenExternalSessionsContribution } from './externalSessions/contribution.js';

function withDispose<T extends object>(runtime: T, dispose: unknown): T {
  return Object.create(Object.getPrototypeOf(runtime), { ...Object.getOwnPropertyDescriptors(runtime),
    dispose: { value: dispose, enumerable: true } }) as T;
}

async function prepare(request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>, context: AgentRuntimeContext) {
  const account = await prepareQwenConnectedAccount(request, context);
  const options: AgentAcpRuntimeOptions = { transport: { kind: 'stdio',
    executable: { kind: 'systemTool', id: QWEN_ACP_COMMAND.toolId }, args: [...QWEN_ACP_COMMAND.args, ...(account?.args ?? [])],
    ...(account ? { env: account.env } : {}) },
  definition: { ...QWEN_ACP_RUNTIME_DEFINITION, ...(account ? { models: account.models } : {}) } };
  return { options, dispose: () => account?.dispose() };
}

export const createQwenAgentRuntime: AgentRuntimeFactory = () => ({ sessions: {
  async open(request, context) {
    const prepared = await prepare(request, context);
    try {
      const runtime = await context.protocols.acp.open(request, prepared.options);
      return withDispose(runtime, async (reason: Parameters<typeof runtime.dispose>[0]) => {
        try { await runtime.dispose(reason); } finally { prepared.dispose(); }
      });
    } catch (error) { prepared.dispose(); throw error; }
  },
  executionRunContextV1: {
    async open(request, context) {
      const prepared = await prepare(request, context);
      try {
        const runtime = await context.protocols.acp.openExecutionRunV1(request, prepared.options);
        return withDispose(runtime, async () => { try { await runtime.dispose(); } finally { prepared.dispose(); } });
      } catch (error) { prepared.dispose(); throw error; }
    },
    async openConversation(request, context) {
      if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({ code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.' });
      const prepared = await prepare(request, context);
      try {
        const runtime = await context.protocols.acp.openExecutionRunConversationV1(request, prepared.options);
        return withDispose(runtime, async () => { try { await runtime.dispose(); } finally { prepared.dispose(); } });
      } catch (error) { prepared.dispose(); throw error; }
    },
  },
} });

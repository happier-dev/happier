import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentRuntimeFactory, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from '../acp/runtimeDeclaration.js';
import { CODEBUDDY_TERMINAL_SURFACE } from '../terminal/contribution.js';
import { prepareCodeBuddyConnectedAccount } from './connectedAccounts.js';
export { codeBuddyExternalSessionsContribution } from '../externalSessions/contribution.js';

// ACP handles can be frozen and expose live getters. Clone descriptors rather
// than snapshotting their values or mutating the original dispose property.
function withDispose<T extends object>(runtime: T, dispose: unknown): T {
  return Object.create(Object.getPrototypeOf(runtime), {
    ...Object.getOwnPropertyDescriptors(runtime), dispose: { value: dispose, enumerable: true },
  }) as T;
}

async function prepare(request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>, context: AgentRuntimeContext) {
  const account = await prepareCodeBuddyConnectedAccount(request, context);
  const { transport, definition } = CODEBUDDY_ACP_RUNTIME_DECLARATION;
  const options: AgentAcpRuntimeOptions = { transport: { ...transport, args: [...transport.args, ...(account?.args ?? [])], ...(account ? { env: account.env } : {}) },
    definition: { ...definition, ...(account ? { models: account.models } : {}) } };
  return { options, dispose: () => account?.dispose() };
}

export const createCodeBuddyAgentRuntime: AgentRuntimeFactory = () => ({
  surfaces: { terminal: CODEBUDDY_TERMINAL_SURFACE },
  sessions: {
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
          return withDispose(runtime, async () => {
            try { await runtime.dispose(); } finally { prepared.dispose(); }
          });
        } catch (error) { prepared.dispose(); throw error; }
      },
      async openConversation(request, context) {
        if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({ code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.' });
        const prepared = await prepare(request, context);
        try {
          const runtime = await context.protocols.acp.openExecutionRunConversationV1(request, prepared.options);
          return withDispose(runtime, async () => {
            try { await runtime.dispose(); } finally { prepared.dispose(); }
          });
        } catch (error) { prepared.dispose(); throw error; }
      },
    },
  },
});

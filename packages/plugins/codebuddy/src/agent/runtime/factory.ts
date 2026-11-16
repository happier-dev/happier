import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentAcpToolNameResolver, AgentRuntimeContext, AgentRuntimeFactory, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from '../acp/runtimeDeclaration.js';
import { CODEBUDDY_TERMINAL_SURFACE } from '../terminal/contribution.js';
import { prepareCodeBuddyConnectedAccount } from './connectedAccounts.js';
import { codeBuddyNativeSandboxSettings } from './launchSettings.js';
export { codeBuddyExternalSessionsContribution } from '../externalSessions/contribution.js';

// CodeBuddy Code 2.162 invokes lazily discovered tools through this native ACP wrapper.
export const resolveCodeBuddyAcpToolName: AgentAcpToolNameResolver = ({ toolName, input }) => {
  const nativeName = toolName.trim().toLowerCase();
  if (nativeName !== 'other' && nativeName !== 'unknown' && nativeName !== 'unknown tool' && nativeName !== 'deferexecutetool') return null;
  const acp = input._acp;
  if (!acp || typeof acp !== 'object' || Array.isArray(acp) || !('kind' in acp) || acp.kind !== 'other'
    || !('title' in acp) || typeof acp.title !== 'string' || acp.title.trim().toLowerCase() !== 'deferexecutetool') return null;
  const name = typeof input.toolName === 'string' ? input.toolName.trim() : '';
  if (!name) return null;
  const params = input.params;
  return { toolName: name, input: params && typeof params === 'object' && !Array.isArray(params)
    ? params as Readonly<Record<string, unknown>> : {} };
};

// ACP handles can be frozen and expose live getters. Clone descriptors rather
// than snapshotting their values or mutating the original dispose property.
function withDispose<T extends object>(runtime: T, dispose: unknown): T {
  return Object.create(Object.getPrototypeOf(runtime), {
    ...Object.getOwnPropertyDescriptors(runtime), dispose: { value: dispose, enumerable: true },
  }) as T;
}

async function prepare(request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>, context: AgentRuntimeContext) {
  const account = await prepareCodeBuddyConnectedAccount({ modelId: request.configuration?.model.value,
    providerBinding: request.providerBinding, nativeSandbox: request.configuration?.nativeSandbox }, context);
  const { transport, definition } = CODEBUDDY_ACP_RUNTIME_DECLARATION;
  const nativeSettingsArgs = request.configuration?.nativeSandbox === undefined ? []
    : ['--settings', JSON.stringify(codeBuddyNativeSandboxSettings(request.configuration.nativeSandbox))];
  const options: AgentAcpRuntimeOptions = { transport: { ...transport, args: [...transport.args, ...(account?.args ?? nativeSettingsArgs)], ...(account ? { env: account.env } : {}) },
    definition: { ...definition, toolNameResolver: resolveCodeBuddyAcpToolName,
      ...(account ? { models: account.models } : {}) } };
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

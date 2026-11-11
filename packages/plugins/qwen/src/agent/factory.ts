import { PluginError } from '@happier-dev/plugin-sdk';
import { join } from 'node:path';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentRuntimeFactory, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { QWEN_ACP_RUNTIME_DEFINITION } from './acp/definition.js';
import { QWEN_ACP_COMMAND } from './acp/preflight.js';
import { prepareQwenConnectedAccount } from './connectedAccount.js';
import { QWEN_PROVIDER_SETTINGS_PATH, qwenProviderLaunchArgs, qwenProviderModelControls } from './providerBinding.js';
export { qwenExternalSessionsContribution } from './externalSessions/contribution.js';

function withDispose<T extends object>(runtime: T, dispose: unknown): T {
  return Object.create(Object.getPrototypeOf(runtime), { ...Object.getOwnPropertyDescriptors(runtime),
    dispose: { value: dispose, enumerable: true } }) as T;
}

async function prepare(request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>, context: AgentRuntimeContext) {
  const account = await prepareQwenConnectedAccount({ modelId: request.configuration?.model.value,
    ...(request.providerBinding ? { providerBinding: request.providerBinding } : {}) }, context);
  const providerBinding = request.providerBinding;
  const providerEnv = providerBinding
    ? (() => {
      if (providerBinding.materialization.kind !== 'configFile') throw new PluginError({ code: 'qwen_provider_materialization_invalid', message: 'Qwen requires its Provider settings file.' });
      return { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(providerBinding.materialization.rootPath, QWEN_PROVIDER_SETTINGS_PATH) };
    })()
    : undefined;
  const providerArgs = providerBinding ? qwenProviderLaunchArgs(providerBinding) : [];
  const options: AgentAcpRuntimeOptions = { transport: { kind: 'stdio',
    executable: { kind: 'systemTool', id: QWEN_ACP_COMMAND.toolId }, args: [...QWEN_ACP_COMMAND.args, ...providerArgs, ...(account?.args ?? [])],
    ...(account || providerEnv ? { env: { ...(account?.env ?? {}), ...(providerEnv ?? {}) } } : {}) },
  definition: { ...QWEN_ACP_RUNTIME_DEFINITION, ...(account?.models ? { models: account.models } : {}), ...(providerBinding ? { models: qwenProviderModelControls(providerBinding) } : {}) } };
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

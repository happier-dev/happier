import { join } from 'node:path';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';

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

function createCopilotAcpOptions(configuration: AgentSessionConfigurationSnapshot | undefined) {
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
  } satisfies AgentAcpRuntimeOptions;
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
  const prepared = await prepareCopilotConnectedAccount(request, context, request.configuration?.model.value);
  let sessionHome: ReturnType<typeof createSecureTempDirectorySync> | undefined;
  const disposePrepared = () => { sessionHome?.cleanup(); prepared.dispose(); };
  try {
    const options = createCopilotAcpOptions(request.configuration);
    let launchOptions: AgentAcpRuntimeOptions = options;
    const servers = Object.entries(request.mcpServers ?? {});
    if (servers.length > 0) {
      sessionHome = createSecureTempDirectorySync({ prefix: 'copilot-session' });
      const configPath = join(sessionHome.path, 'mcp-config.json');
      // Copilot 1.0.111 ignores ACP mcpServers. Its supported per-launch file
      // overrides same-name global entries without changing the user's home.
      // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
      await writeAtomicTextFile({ path: configPath, mode: 0o600, contents: JSON.stringify({
        mcpServers: Object.fromEntries(servers.map(([name, server]) => [name, {
          type: 'local', command: server.command, args: [...(server.args ?? [])],
          env: { ...server.env }, tools: ['*'],
        }])),
      }) });
      launchOptions = { ...options, transport: { ...options.transport,
        args: [...options.transport.args, '--additional-mcp-config', `@${configPath}`],
      }, requiredFiles: [configPath] };
    }
    const runtime = await open(prepared.request, prepared.models
      ? { ...launchOptions, definition: { ...options.definition, models: prepared.models } } : launchOptions);
    if (!prepared.models && !sessionHome) return runtime;
    // ACP returns frozen closure handles. Preserve their live getter descriptors.
    return Object.create(Object.getPrototypeOf(runtime), {
      ...Object.getOwnPropertyDescriptors(runtime),
      dispose: { enumerable: true, value: async (reason?: AgentSessionDisposeReason) => {
        try { await runtime.dispose(reason); } finally { disposePrepared(); }
      } },
    }) as TRuntime;
  } catch (error) { disposePrepared(); throw error; }
}

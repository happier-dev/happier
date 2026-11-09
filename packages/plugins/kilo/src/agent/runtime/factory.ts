import type {
  AgentAcpRuntimeOptions,
  AgentExecutionRunConversationRuntimeV1,
  AgentRuntimeFactory,
  AgentSessionConfigurationSnapshot,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { normalizeAcpPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';
import { KILO_PERMISSION_ENV } from '../permissions/kiloPermissionPolicy.js';

import { buildKiloAcpEnv, buildKiloAcpToolNameResolver } from '../acp/callbacks.js';
import { KILO_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { KILO_ACP_COMMAND } from '../acp/command.js';
import { kiloProviderModelControls } from '../providerBinding/models.js';
import { prepareKiloConnectedAccount } from './connectedAccounts.js';
export { kiloExternalSessionsContribution } from '../externalSessions/contribution.js';

async function createKiloAcpOptions(
  request: Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'mcpServers' | 'mcpToolPolicy' | 'providerBinding'> & Readonly<{
    configuration?: AgentSessionConfigurationSnapshot;
  }>,
): Promise<AgentAcpRuntimeOptions> {
  if (!request.configuration) throw new Error('Kilo requires the host-projected Agent session configuration');
  const account = await prepareKiloConnectedAccount(request);
  const models = account.models ?? kiloProviderModelControls(request);
  return {
    transport: {
      kind: 'stdio',
      executable: { kind: 'systemTool', id: KILO_ACP_COMMAND.toolId },
      args: [...KILO_ACP_COMMAND.args],
      env: { ...buildKiloAcpEnv({
        launchEnvironment: request.launchEnvironment,
        permissionIntent: request.configuration.permissionIntent.value,
        mcpToolPolicy: request.mcpToolPolicy,
      }), ...account.env },
    },
    definition: { ...KILO_ACP_RUNTIME_DEFINITION, toolNameResolver: buildKiloAcpToolNameResolver(request),
      ...(models ? { models } : {}) },
  };
}

export const createKiloAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request, context) {
      return context.protocols.acp.open(request, await createKiloAcpOptions(request));
    },
    executionRunContextV1: {
      async openConversation(request, context) {
        if (!context.protocols.acp.openExecutionRunConversationV1) {
          throw new PluginError({ code: 'execution_run_protocol_unsupported',
            message: 'This host does not support retained detached ACP conversations.' });
        }
        const runtimeOptions = await createKiloAcpOptions(request);
        const launchPolicy = runtimeOptions.transport.kind === 'stdio'
          ? runtimeOptions.transport.env?.[KILO_PERMISSION_ENV]
          : undefined;
        const launchIntent = normalizeAcpPermissionIntent(request.configuration?.permissionIntent.value ?? 'default');
        const isPermissionKey = (key: string) => key.toUpperCase() === KILO_PERMISSION_ENV;
        const nativePolicyOverride = Object.keys(request.launchEnvironment?.values ?? {}).some(isPermissionKey)
          || (request.launchEnvironment?.unset ?? []).some(isPermissionKey);
        const conversation = await context.protocols.acp.openExecutionRunConversationV1(request, runtimeOptions);
        return {
          ...conversation,
          async send(input, sendOptions) {
            if (sendOptions?.permissionIntent !== undefined) {
              const expectedPolicy = buildKiloAcpEnv({ permissionIntent: sendOptions.permissionIntent,
                mcpToolPolicy: request.mcpToolPolicy })[KILO_PERMISSION_ENV];
              // Both strings come from the same canonical projector; authored overrides are refused below.
              const policyMatches = typeof launchPolicy === 'string' && launchPolicy === expectedPolicy;
              if (sendOptions.permissionIntent !== launchIntent || nativePolicyOverride
                || request.configuration?.mode.value != null || !policyMatches) {
                return { status: 'unsupported', diagnostic: { code: 'execution_run_permission_intent_unsupported',
                  severity: 'error', message: 'Kilo cannot change or prove this input permission policy without reopening its native process.' } };
              }
              const { permissionIntent: _verifiedIntent, ...verifiedOptions } = sendOptions;
              return await conversation.send(input, verifiedOptions);
            }
            return await conversation.send(input, sendOptions);
          },
        } satisfies AgentExecutionRunConversationRuntimeV1;
      },
      open: async (request, context) => context.protocols.acp.openExecutionRunV1(
        request,
        await createKiloAcpOptions(request),
      ),
    },
  },
});

import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentRuntimeFactory, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { FX_PERMISSION_MODE_MAPPING } from '../acp/permissionModes.js';
import { FX_ACP_STEERING } from '../acp/steering.js';
import { FX_SESSION_UPDATES } from '../acp/sessionUpdates.js';
import { FX_PROMPT_USAGE } from '../acp/usage.js';
import { FX_AUTH_STATUS_COMMAND, parseFxStatusCommand } from '../auth/status.js';
import { FX_ACP_COMMAND } from '../preflight.js';
import { FX_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
import { prepareFxConnectedAccount } from '../auth/connectedAccount.js';
export { fxExternalSessionsContribution } from '../externalSessions/contribution.js';

const options = {
  transport: { kind: 'stdio', executable: { kind: 'systemTool', id: FX_ACP_COMMAND.toolId }, args: [...FX_ACP_COMMAND.args] },
  definition: { modelConfigOptionId: 'model', allowExplicitUnlistedModels: true, permissionModeMapping: FX_PERMISSION_MODE_MAPPING,
    sessionUpdates: FX_SESSION_UPDATES, usage: FX_PROMPT_USAGE,
    mcp: { policy: 'pass_through' }, delivery: { steer: FX_ACP_STEERING } },
} satisfies AgentAcpRuntimeOptions;

async function verifyProviderBinding(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  context: AgentSessionRuntimeContext | AgentExecutionRunRuntimeContextV1,
): Promise<void> {
  const binding = request.providerBinding;
  if (!binding) return;
  const refuse = () => new PluginError({ code: 'fx_provider_credential_source_mismatch',
    message: 'FX could not confirm the selected Provider and model in its private native settings. Retry the connection or inspect FX status.' });
  if (binding.materialization.kind !== 'configFile' || binding.upstream.protocol !== 'openai-chat') throw refuse();
  const nativeLaunch = context.session
    ? context.session.services.nativeLaunch
    : context.executionRun.services.nativeLaunch;
  if (!nativeLaunch) throw refuse();
  // Both commands use the host's finalized launch environment. FX's saved
  // credential_source overrides environment precedence; never silently bill a
  // different account. This explicit check runs once per bound spawn, not at
  // idle or after native provider changes (configOptions owns the live route).
  let result: PluginProcessResult;
  try {
    result = await context.services.exec.run({ executable: { kind: 'systemTool', id: FX_ACP_COMMAND.toolId },
      args: FX_AUTH_STATUS_COMMAND.args, cwd: request.cwd }, { signal: context.signal, nativeLaunch });
  } catch {
    context.signal.throwIfAborted();
    throw refuse();
  }
  const observed = result.termination.observed;
  const facts = parseFxStatusCommand({ ok: observed.kind === 'exit' && observed.exitCode === 0 && !result.stdoutTruncated,
    exitCode: observed.kind === 'exit' ? observed.exitCode : null, stdout: new TextDecoder().decode(result.stdout), stderr: '' });
  if (facts.status.state !== 'logged_in'
    || (facts.credentialSource !== 'AI_GATEWAY_API_KEY' && facts.credentialSource !== 'configured provider')
    || facts.model !== binding.model.id) throw refuse();
}

export const createFxAgentRuntime: AgentRuntimeFactory = () => ({ surfaces: { terminal: FX_TERMINAL_CONTRIBUTION }, sessions: {
  async open(request, context) {
    await verifyProviderBinding(request, context);
    const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal);
    return context.protocols.acp.open({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, options);
  },
  executionRunContextV1: {
    async open(request, context) {
      await verifyProviderBinding(request, context);
      const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal);
      return context.protocols.acp.openExecutionRunV1({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, options);
    },
    async openConversation(request, context) {
      if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({ code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.' });
      await verifyProviderBinding(request, context);
      const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal);
      return context.protocols.acp.openExecutionRunConversationV1({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, options);
    },
  },
} });

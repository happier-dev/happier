import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentRuntimeFactory, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { FX_PERMISSION_MODE_MAPPING } from '../acp/permissionModes.js';
import { FX_ACP_STEERING } from '../acp/steering.js';
import { FX_SESSION_UPDATES } from '../acp/sessionUpdates.js';
import { FX_PROMPT_USAGE } from '../acp/usage.js';
import { FX_AUTH_STATUS_COMMAND, parseFxStatusCommand } from '../auth/status.js';
import { FX_ACP_COMMAND } from '../preflight.js';
import { FX_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
import { prepareFxConnectedAccount, hasFxConnectedAccount } from '../auth/connectedAccount.js';
export { fxExternalSessionsContribution } from '../externalSessions/contribution.js';

const options = {
  transport: { kind: 'stdio', executable: { kind: 'systemTool', id: FX_ACP_COMMAND.toolId }, args: [...FX_ACP_COMMAND.args] },
  definition: { modelConfigOptionId: 'model', allowExplicitUnlistedModels: true, permissionModeMapping: FX_PERMISSION_MODE_MAPPING,
    sessionUpdates: FX_SESSION_UPDATES, usage: FX_PROMPT_USAGE,
    mcp: { policy: 'pass_through' }, delivery: { steer: FX_ACP_STEERING } },
} satisfies AgentAcpRuntimeOptions;

function createFxAcpOptions(request: Pick<AgentSessionOpenRequest, 'providerBinding' | 'launchEnvironment'>): AgentAcpRuntimeOptions {
  if (!request.providerBinding && !hasFxConnectedAccount(request.launchEnvironment)) return options;
  // Native choices carry no independent observation of membership in the selected source.
  return { ...options, definition: { ...options.definition, models: {
    catalogConfidence: 'account_unverified',
    projectModel: (_raw, model) => model,
  } } };
}

async function verifyProviderBinding(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  context: AgentSessionRuntimeContext | AgentExecutionRunRuntimeContextV1,
): Promise<void> {
  const binding = request.providerBinding;
  if (!binding) return;
  const refuse = (reason: 'unsupported_binding' | 'native_launch_unavailable' | 'native_status_failed'
    | 'native_status_exit_failed' | 'native_status_truncated' | 'native_status_invalid'
    | 'auth_not_confirmed' | 'credential_source_mismatch' | 'model_mismatch', providerErrorMessage?: string) => new PluginError({
    code: 'fx_provider_credential_source_mismatch',
    message: 'FX could not confirm the selected Provider and model in its private native settings. Retry the connection or inspect FX status.',
    // Preserve only the predicate we decided here, never native status values,
    // model IDs, output or credentials. The host already carries this envelope.
    details: { failureCause: { phase: 'authentication', failureReason: 'unknown', providerErrorCode: `fx_provider_${reason}`,
      ...(providerErrorMessage ? { providerErrorMessage } : {}) } },
  });
  if (binding.materialization.kind !== 'configFile' || binding.upstream.protocol !== 'openai-chat') throw refuse('unsupported_binding');
  const nativeLaunch = context.session
    ? context.session.services.nativeLaunch
    : context.executionRun.services.nativeLaunch;
  if (!nativeLaunch) throw refuse('native_launch_unavailable');
  // Both commands use the host's finalized launch environment. Confirm the
  // native source and model before ACP so a different account is never silently
  // billed. This explicit check runs once per bound spawn, not at
  // idle or after native provider changes (configOptions owns the live route).
  // Exec owns launch refusal and cancellation. Preserve its typed cause rather
  // than relabeling an unavailable executable or working directory as auth.
  const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: FX_ACP_COMMAND.toolId },
    args: FX_AUTH_STATUS_COMMAND.args, cwd: request.cwd }, { signal: context.signal, nativeLaunch });
  const observed = result.termination.observed;
  if (observed.kind !== 'exit') throw refuse('native_status_failed');
  if (observed.exitCode !== 0) throw refuse('native_status_exit_failed', `FX status exited with code ${observed.exitCode}`);
  if (result.stdoutTruncated) throw refuse('native_status_truncated');
  const facts = parseFxStatusCommand({ ok: true, exitCode: observed.exitCode,
    stdout: new TextDecoder().decode(result.stdout), stderr: '' });
  if (facts.status.state === 'unknown' && facts.status.reason === 'probe_failed') throw refuse('native_status_invalid');
  if (facts.status.state !== 'logged_in') throw refuse('auth_not_confirmed');
  if (facts.credentialSource !== 'AI_GATEWAY_API_KEY' && facts.credentialSource !== 'configured provider') throw refuse('credential_source_mismatch');
  if (facts.model !== binding.model.id) throw refuse('model_mismatch');
}

export const createFxAgentRuntime: AgentRuntimeFactory = () => ({ surfaces: { terminal: FX_TERMINAL_CONTRIBUTION }, sessions: {
  async open(request, context) {
    await verifyProviderBinding(request, context);
    const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal, request.configuration?.model.value);
    return context.protocols.acp.open({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, createFxAcpOptions(request));
  },
  executionRunContextV1: {
    async open(request, context) {
      await verifyProviderBinding(request, context);
      const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal, request.configuration?.model.value);
      return context.protocols.acp.openExecutionRunV1({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, createFxAcpOptions(request));
    },
    async openConversation(request, context) {
      if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({ code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.' });
      await verifyProviderBinding(request, context);
      const launchEnvironment = await prepareFxConnectedAccount(request.launchEnvironment, context.signal, request.configuration?.model.value);
      return context.protocols.acp.openExecutionRunConversationV1({ ...request, ...(launchEnvironment ? { launchEnvironment } : {}) }, createFxAcpOptions(request));
    },
  },
} });

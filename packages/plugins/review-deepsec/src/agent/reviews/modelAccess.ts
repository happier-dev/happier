import type { AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { buildAgentTargetKeyV2 } from '@happier-dev/plugin-sdk/agents';
import { DEEPSEC_AGENT_CLIS } from './profile.js';
import { buildDeepSecLaunchEnvironment, omitDeepSecProviderEnvironment, readDeepSecLaunchEnvironment,
  readDeepSecProviderLaunch, readDeepSecConnectedAccountLaunch, type DeepSecProviderRoute } from '../providerBinding.js';

type DeepSecAgentCli = typeof DEEPSEC_AGENT_CLIS[number];
export class DeepSecProviderHarnessMismatchError extends Error {}

type DeepSecModelAccess = Readonly<{
  environment: Readonly<Record<string, string>>;
  agentCli: DeepSecAgentCli | null;
  provider?: DeepSecProviderRoute;
  claudeSubscription: boolean;
  gateway?: true;
  nativeLogin?: true;
}>;

export function prepareDeepSecModelAccess(
  request: AgentExecutionRunOpenRequest,
  agentCli: DeepSecAgentCli | null | undefined,
): DeepSecModelAccess {
  if (request.runnerAgentTarget) {
    const runnerKey = buildAgentTargetKeyV2(request.runnerAgentTarget);
    const runner = new Map([
      [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }), 'codex' as const],
      [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }), 'claude' as const],
    ]).get(runnerKey);
    if (!runner) throw new PluginError({ code: 'deepsec_runner_unsupported', message: 'The selected runner is not supported by DeepSec.' });
    agentCli = runner;
  }
  if (request.providerBinding) {
    const provider = readDeepSecProviderLaunch(request.providerBinding, request.launchEnvironment);
    if (agentCli && agentCli !== provider.route.agent) {
      throw new DeepSecProviderHarnessMismatchError(`The selected DeepSec Provider requires the ${provider.route.agent} harness.`);
    }
    return { environment: provider.environment, agentCli: provider.route.agent,
      provider: provider.route, claudeSubscription: false };
  }
  // Admission already selected and materialized the runner. The adapter only
  // translates the environment accepted by DeepSec's nested Agent SDKs.
  const values = readDeepSecLaunchEnvironment(request.launchEnvironment);
  const nativeValues = omitDeepSecProviderEnvironment(values);
  const selectedAccount = Boolean(request.runnerConnectedAccountPurposes?.length);
  const materialization = request.runnerConnectedAccountMaterialization;
  const unsupported = () => new PluginError({ code: 'deepsec_runner_account_unsupported',
    message: 'DeepSec cannot preserve the selected runner account. Choose another model access route.' });
  if (selectedAccount && !materialization) throw unsupported();
  if (selectedAccount && materialization && (materialization.kind === 'engineConfig'
    || (agentCli === 'claude' && (values.ANTHROPIC_API_KEY || values.ANTHROPIC_AUTH_TOKEN)))) {
    if (agentCli !== 'claude' && agentCli !== 'codex') throw unsupported();
    const provider = readDeepSecConnectedAccountLaunch(materialization, request.launchEnvironment, agentCli, request.modelSelection?.modelId ?? '');
    return { environment: provider.environment, agentCli, provider: provider.route, claudeSubscription: false };
  }
  const oauthToken = values.CLAUDE_CODE_OAUTH_TOKEN || values.ANTHROPIC_OAUTH_TOKEN;
  if (oauthToken && agentCli !== 'codex') return { environment: buildDeepSecLaunchEnvironment({ ...nativeValues,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    agentCli: 'claude', claudeSubscription: true };
  // DeepSec's nested Claude SDK does not forward the admitted native home.
  // Without its access token it would silently use the Machine's default login.
  if (agentCli !== 'codex' && nativeValues.CLAUDE_CONFIG_DIR?.trim()) throw new PluginError({
    code: selectedAccount ? 'deepsec_runner_account_unsupported' : 'deepsec_provider_transport_unsupported',
    message: 'DeepSec cannot preserve the selected Claude native home without its access token. Choose another model access route.',
  });
  // Codex's native SDK accepts only a materialized home for a bound login.
  // Its own resolver checks CODEX_HOME before the ordinary Machine home.
  if (selectedAccount && !(agentCli === 'codex' && materialization?.kind === 'configFile'
    && nativeValues.CODEX_HOME?.trim())) throw unsupported();
  const gatewayKey = Object.entries(values).find(([key]) => key.toUpperCase() === 'AI_GATEWAY_API_KEY')?.[1];
  if (!selectedAccount && gatewayKey?.trim()) return { environment: buildDeepSecLaunchEnvironment({ ...nativeValues, AI_GATEWAY_API_KEY: gatewayKey }),
    agentCli: agentCli ?? null, claudeSubscription: false, gateway: true };
  return {
    environment: buildDeepSecLaunchEnvironment(nativeValues), agentCli: agentCli ?? null,
    claudeSubscription: false, nativeLogin: true,
  };
}

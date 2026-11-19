import { PluginError } from '@happier-dev/plugin-sdk';
import { CLAUDE_SUBSCRIPTION_ACCESS_TOKEN_ENVIRONMENT_REQUEST_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountBindingSummary } from '@happier-dev/plugin-sdk/connected-accounts';

import { buildDeepSecLaunchEnvironment } from './providerBinding.js';

export const DEEPSEC_CLAUDE_ACCOUNT_PURPOSE = 'claude-subscription';

export async function prepareDeepSecClaudeAccount(context: AgentRuntimeContext, agentCli: string | null | undefined,
  binding: ConnectedAccountBindingSummary) {
  if (agentCli && agentCli !== 'claude') {
    throw new PluginError({ code: 'deepsec_connected_account_harness_mismatch',
      message: 'The selected Claude Connected Account requires the Claude harness.' });
  }
  const materialized = await context.services.connectedAccounts.materialize(DEEPSEC_CLAUDE_ACCOUNT_PURPOSE,
    CLAUDE_SUBSCRIPTION_ACCESS_TOKEN_ENVIRONMENT_REQUEST_V1, { signal: context.signal, expectedAccount: binding.account });
  const accessToken = materialized.kind === 'environment'
    ? materialized.env[CLAUDE_SUBSCRIPTION_ACCESS_TOKEN_ENVIRONMENT_REQUEST_V1.keys[0]] : undefined;
  if (!accessToken?.trim()) {
    throw new PluginError({ code: 'deepsec_connected_account_credential_unavailable',
      message: 'The selected Claude Connected Account did not supply an access token.' });
  }
  // DeepSec 2.3.12's Claude SDK environment forwards this native key. Empty
  // competing keys prevent repository dotenv and Gateway credentials taking over.
  return buildDeepSecLaunchEnvironment({
    CLAUDE_CODE_OAUTH_TOKEN: accessToken, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
}

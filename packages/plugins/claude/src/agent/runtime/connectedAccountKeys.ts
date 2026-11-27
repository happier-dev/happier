import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentConnectedAccountLaunchContributionV1, AgentLaunchEnvironment, AgentPreflightSessionControlsContributionV1, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  KIMI_CONNECTED_ACCOUNT_SERVICE,
  KIMI_CODE_API_KEY_ENV,
  KIMI_CODE_ANTHROPIC_BASE_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { buildClaudeNativeUpstreamEnvironment, isClaudeProviderOwnedEnvName } from '../providerBinding/adapter.js';

export const CLAUDE_KIMI_PURPOSE = 'kimi-code-api-key';
export const CLAUDE_KIMI_DECLARATION = { purpose: CLAUDE_KIMI_PURPOSE, service: KIMI_CONNECTED_ACCOUNT_SERVICE,
  materializationKinds: ['environment' as const], credentialKinds: ['token' as const] };
export const CLAUDE_KIMI_ENVIRONMENT_USES = [KIMI_CODE_API_KEY_ENV, KIMI_CODE_ANTHROPIC_BASE_ENV]
  .map(environmentKey => ({ purpose: CLAUDE_KIMI_PURPOSE, environmentKey }));

const MODEL_SOURCE_PURPOSES = [CLAUDE_KIMI_PURPOSE, 'model_upstream', 'model_upstream_api_key'] as const;
function hasSelectedKey(purposes: readonly string[], providerBinding = false): boolean {
  if (!purposes.includes(CLAUDE_KIMI_PURPOSE)) return false;
  if (providerBinding || MODEL_SOURCE_PURPOSES.filter(purpose => purposes.includes(purpose)).length > 1) {
    throw new PluginError({ code: 'claude_connected_account_provider_conflict', message: 'Select one model source for Claude.' });
  }
  return true;
}

function prepareEnvironment(environment: AgentLaunchEnvironment, model?: string): AgentLaunchEnvironment {
  const key = environment.values[KIMI_CODE_API_KEY_ENV];
  const baseUrl = environment.values[KIMI_CODE_ANTHROPIC_BASE_ENV];
  if (!key || !baseUrl) throw new PluginError({ code: 'claude_connected_account_material_unavailable',
    message: 'The selected Kimi Code key is unavailable. Reconnect the account.' });
  const overlay = buildClaudeNativeUpstreamEnvironment({ baseUrl, apiKey: key, authToken: null,
    customHeaders: null, helperModels: model ? {} : undefined, sessionModelId: model ?? '' });
  const values = Object.fromEntries(Object.entries(environment.values).filter(([name]) => !isClaudeProviderOwnedEnvName(name)
    && name !== KIMI_CODE_API_KEY_ENV && name !== KIMI_CODE_ANTHROPIC_BASE_ENV));
  for (const row of overlay) if (row.value !== null) values[row.name] = row.value;
  return { values, unset: [...new Set([...environment.unset, ...overlay.map(row => row.name), KIMI_CODE_API_KEY_ENV, KIMI_CODE_ANTHROPIC_BASE_ENV])]
    .filter(name => !(name in values)) };
}

function resolveSelectedAccountModel(value: string | null | undefined): string {
  const model = value?.trim();
  if (!model || model === 'default') throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the selected Claude Connected Account.', details: { failureCause: {
      code: 'agent_startup_model_reconciliation_failed', phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  return model;
}

export function prepareClaudeConnectedAccountKeyRequest<T extends Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'connectedAccounts' | 'configuration' | 'providerBinding'>>(request: T): T {
  if (!hasSelectedKey(request.connectedAccounts?.map(row => row.purpose) ?? [], Boolean(request.providerBinding))) return request;
  const model = resolveSelectedAccountModel(request.configuration?.model.value);
  return { ...request, launchEnvironment: prepareEnvironment(request.launchEnvironment ?? { values: {}, unset: [] }, model) };
}

export const prepareClaudeConnectedAccountLaunchEnvironment: NonNullable<AgentConnectedAccountLaunchContributionV1['prepareEnvironment']> = input => {
  const purposes = input.purposes.filter(purpose => MODEL_SOURCE_PURPOSES.some(modelPurpose => modelPurpose === purpose));
  if (hasSelectedKey(purposes)) {
    const model = resolveSelectedAccountModel(input.modelId);
    return { purposes, launchEnvironment: prepareEnvironment(input.launchEnvironment, model), materialization: { v: 1, kind: 'spawnEnv' } };
  }
  return { purposes, launchEnvironment: input.launchEnvironment, ...(purposes.length ? { materialization: { v: 1 as const, kind: 'spawnEnv' as const } } : {}) };
};

export const prepareClaudeConnectedAccountKeyPreflight: NonNullable<AgentPreflightSessionControlsContributionV1['prepareLaunchEnvironment']> = async ({ environment, modelId, connectedAccounts, signal }) => {
  const bindings = await Promise.all(MODEL_SOURCE_PURPOSES.map(async purpose =>
    await connectedAccounts.getBinding(purpose, { signal }) ? purpose : null));
  if (!hasSelectedKey(bindings.filter((purpose): purpose is typeof MODEL_SOURCE_PURPOSES[number] => purpose !== null))) return { environment, dispose() {} };
  const prepared = prepareEnvironment({ values: environment, unset: [] }, modelId && modelId !== 'default' ? modelId : undefined);
  return { environment: prepared.values, unset: prepared.unset, catalogConfidence: 'account_unverified', dispose() {} };
};

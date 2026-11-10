import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentLaunchEnvironment, AgentPreflightSessionControlsContributionV1, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE, OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import { CODEX_PROVIDER_SECRET_ENV_KEY, CODEX_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding/adapter.js';
import { buildCodexNativeUpstreamProvider, codexNativeUpstreamConfigOverrides, CODEX_NATIVE_UPSTREAM_CONFIG_ENV } from '../providerBinding/runtimeConfig.js';

export const CODEX_KEY_ACCOUNTS = [
  { purpose: 'kimi-code-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, key: KIMI_CODE_API_KEY_ENV, base: KIMI_CODE_API_BASE_ENV },
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, key: OPENAI_SELECTED_API_KEY_ENV, base: null },
] as const;
export const CODEX_KEY_DECLARATIONS = CODEX_KEY_ACCOUNTS.map(({ purpose, service }) => ({ purpose, service,
  materializationKinds: ['environment'] as const, credentialKinds: ['token'] as const }));
export const CODEX_KEY_ENVIRONMENT_USES = CODEX_KEY_ACCOUNTS.flatMap(row => [row.key, ...(row.base ? [row.base] : [])]
  .map(environmentKey => ({ purpose: row.purpose, environmentKey })));

const MODEL_SOURCE_PURPOSES = [...CODEX_KEY_ACCOUNTS.map(row => row.purpose), 'primary'];
function selectedKey(purposes: readonly string[], hasProvider = false) {
  const rows = CODEX_KEY_ACCOUNTS.filter(row => purposes.includes(row.purpose));
  if (rows.length && (hasProvider || MODEL_SOURCE_PURPOSES.filter(purpose => purposes.includes(purpose)).length > 1)) {
    throw new PluginError({ code: 'codex_connected_account_provider_conflict', message: 'Select one model source for Codex.' });
  }
  return rows[0];
}

function prepareEnvironment(environment: AgentLaunchEnvironment, row: typeof CODEX_KEY_ACCOUNTS[number]): AgentLaunchEnvironment {
  const secret = environment.values[row.key];
  const baseUrl = row.base ? environment.values[row.base] : 'https://api.openai.com/v1';
  if (!secret || !baseUrl) throw new PluginError({ code: 'codex_connected_account_material_unavailable', message: 'The selected API key is unavailable. Reconnect the account.' });
  const modelProvider = `happier_${createHash('sha256').update(row.purpose).digest('hex').slice(0, 32)}`;
  const config = { v: 1, modelProvider, config: { [`model_providers.${modelProvider}`]: {
    ...buildCodexNativeUpstreamProvider(baseUrl), env_key: CODEX_PROVIDER_SECRET_ENV_KEY } } };
  const owned = new Set<string>(CODEX_PROVIDER_OWNED_ENV_KEYS.map(name => name.toUpperCase()));
  owned.add(row.key.toUpperCase());
  if (row.base) owned.add(row.base.toUpperCase());
  const values = { ...Object.fromEntries(Object.entries(environment.values).filter(([name]) => !owned.has(name.toUpperCase()))),
    [CODEX_PROVIDER_SECRET_ENV_KEY]: secret, [CODEX_NATIVE_UPSTREAM_CONFIG_ENV]: JSON.stringify(config) };
  return { values, unset: [...new Set([...environment.unset, ...CODEX_PROVIDER_OWNED_ENV_KEYS, row.key, ...(row.base ? [row.base] : [])])].filter(name => !(name in values)) };
}

export function prepareCodexConnectedAccountKeyRequest<T extends Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'connectedAccounts' | 'configuration' | 'providerBinding'>>(request: T): T {
  const row = selectedKey(request.connectedAccounts?.map(selection => selection.purpose) ?? [], Boolean(request.providerBinding));
  if (!row) return request;
  const model = request.configuration?.model.value?.trim();
  if (!model || model === 'default') throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the selected Codex Connected Account.', details: { failureCause: {
      code: 'agent_startup_model_reconciliation_failed', phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  return { ...request, launchEnvironment: prepareEnvironment(request.launchEnvironment ?? { values: {}, unset: [] }, row) };
}

export const prepareCodexConnectedAccountKeyPreflight: NonNullable<AgentPreflightSessionControlsContributionV1['prepareLaunchEnvironment']> = async ({ environment, connectedAccounts, signal }) => {
  const bindings = await Promise.all(MODEL_SOURCE_PURPOSES.map(async purpose =>
    await connectedAccounts.getBinding(purpose, { signal }) ? purpose : null));
  const row = selectedKey(bindings.filter((purpose): purpose is string => purpose !== null));
  if (row) {
    const prepared = prepareEnvironment({ values: environment, unset: [] }, row);
    return { environment: prepared.values, unset: prepared.unset, catalogConfidence: 'account_unverified',
      commandArgsSuffix: codexNativeUpstreamConfigOverrides(prepared.values).flatMap(value => ['-c', value]), dispose() {} };
  }
  return { environment, dispose() {} };
};

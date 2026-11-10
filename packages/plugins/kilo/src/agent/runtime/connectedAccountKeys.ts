import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentLaunchEnvironment } from '@happier-dev/plugin-sdk/agents/runtime';
import { ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_API_KEY_ENV } from '@happier-dev/plugins-claude/connected-account-service';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE, OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE, GEMINI_API_KEY_ENV } from '@happier-dev/plugins-gemini/connected-account-service';
import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE, XAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-grok/connected-account-service';
import { buildKiloNativeUpstreamConfig, KILO_PROVIDER_OWNED_ENV_KEYS, KILO_PROVIDER_SECRET_ENV_KEY } from '../providerBinding/adapter.js';

export const KILO_KEY_ACCOUNTS = [
  { purpose: 'anthropic-api-key', service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, key: ANTHROPIC_API_KEY_ENV,
    base: 'https://api.anthropic.com/v1', baseEnv: null, npm: '@ai-sdk/anthropic' },
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, key: OPENAI_SELECTED_API_KEY_ENV,
    base: 'https://api.openai.com/v1', baseEnv: null, npm: '@ai-sdk/openai' },
  { purpose: 'gemini-api-key', service: GEMINI_CONNECTED_ACCOUNT_SERVICE, key: GEMINI_API_KEY_ENV,
    base: 'https://generativelanguage.googleapis.com/v1beta', baseEnv: null, npm: '@ai-sdk/google' },
  { purpose: 'kimi-code-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, key: KIMI_CODE_API_KEY_ENV,
    base: null, baseEnv: KIMI_CODE_API_BASE_ENV, npm: '@ai-sdk/openai-compatible' },
  { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, key: XAI_SELECTED_API_KEY_ENV,
    base: 'https://api.x.ai/v1', baseEnv: null, npm: '@ai-sdk/openai-compatible' },
] as const;
export const KILO_KEY_DECLARATIONS = KILO_KEY_ACCOUNTS.map(({ purpose, service }) => ({ purpose, service,
  materializationKinds: ['environment'] as const, credentialKinds: ['token'] as const }));
export const KILO_KEY_ENVIRONMENT_USES = KILO_KEY_ACCOUNTS.flatMap(row => [row.key, ...(row.baseEnv ? [row.baseEnv] : [])]
  .map(environmentKey => ({ purpose: row.purpose, environmentKey })));

export function selectKiloConnectedAccountKey(purposes: readonly string[], hasOtherSource: boolean) {
  const selected = KILO_KEY_ACCOUNTS.filter(row => purposes.includes(row.purpose));
  if (selected.length && (selected.length > 1 || hasOtherSource)) throw new PluginError({
    code: 'plugin_kilo_subscription_provider_conflict', message: 'Select one model source for Kilo.' });
  return selected[0];
}

export function prepareKiloConnectedAccountKey(environment: AgentLaunchEnvironment, row: typeof KILO_KEY_ACCOUNTS[number], model?: string) {
  const secret = environment.values[row.key];
  const baseURL = row.baseEnv ? environment.values[row.baseEnv] : row.base;
  if (!secret || !baseURL) throw new PluginError({ code: 'plugin_kilo_connected_account_material_unavailable',
    message: 'The selected API key is unavailable. Reconnect the account.' });
  const key = `happier_${createHash('sha256').update(row.purpose).digest('hex').slice(0, 32)}`;
  const sourceKeys = KILO_KEY_ENVIRONMENT_USES.map(use => use.environmentKey);
  const owned = new Set<string>([...KILO_PROVIDER_OWNED_ENV_KEYS, ...sourceKeys].map(name => name.toUpperCase()));
  const env = { [KILO_PROVIDER_SECRET_ENV_KEY]: secret, KILO_AUTH_CONTENT: '{}',
    KILO_CONFIG_CONTENT: buildKiloNativeUpstreamConfig({ key, npm: row.npm,
      ...(model ? { model: { id: model, name: model } } : {}), baseURL, hasCredential: true }) };
  const values = { ...Object.fromEntries(Object.entries(environment.values).filter(([name]) => !owned.has(name.toUpperCase()))), ...env };
  return { env, launchEnvironment: { values,
    unset: [...new Set([...environment.unset, ...KILO_PROVIDER_OWNED_ENV_KEYS, ...sourceKeys])].filter(name => !(name in values)) },
    nativeModelId: model ? `${key}/${model}` : undefined };
}

export function requireKiloConnectedAccountModel(modelId: string | null | undefined): string {
  const model = modelId?.trim();
  if (!model || model === 'default') throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the Kilo Connected Account.', details: { failureCause: {
      code: 'agent_startup_model_reconciliation_failed', phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  return model;
}

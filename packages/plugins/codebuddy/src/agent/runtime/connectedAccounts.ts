import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpModelControls, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE, OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_SELECTED_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE, XAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-grok/connected-account-service';

export const CODEBUDDY_KEY_ACCOUNTS = [
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, key: OPENAI_SELECTED_API_KEY_ENV, base: 'https://api.openai.com/v1', baseKey: null },
  { purpose: 'kimi-code-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, key: KIMI_SELECTED_CODE_API_KEY_ENV, base: null, baseKey: KIMI_CODE_API_BASE_ENV },
  { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, key: XAI_SELECTED_API_KEY_ENV, base: 'https://api.x.ai/v1', baseKey: null },
] as const;

function refuse(code: string, message: string): never {
  throw new PluginError({ code, message });
}

function modelSelectionRequired(): never {
  throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Select an explicit model before starting CodeBuddy with a connected account.',
    details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
      phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
}

export function buildCodeBuddyNativeConfiguration(input: Readonly<{
  modelId: string; api: string; url: string; apiKey?: string; customHeaders: string; supportsReasoning?: true;
}>) {
  const { modelId, customHeaders } = input;
  // CodeBuddy 2.181.0 EnvProductProvider accepts this per-process overlay. The
  // custom tag disables catalogue max-token/temperature fallbacks; omitting
  // maxOutputTokens makes configureModelConfig delete maxTokens before the
  // Responses serializer. No native home or credential file is replaced.
  const native = { productFeatures: { ResponsesStore: false }, models: [{ id: modelId, name: modelId, tags: ['custom'],
    api: input.api, url: input.url, ...(input.apiKey ? { apiKey: input.apiKey } : {}), supportsToolCall: true,
    ...(input.supportsReasoning ? { supportsReasoning: true } : {}) }] };
  // Explicit settings override saved settings.env. Native logs the settings
  // object, so only noncredential headers go here. Native model.apiKey applies
  // Authorization after custom headers and retains the access-only bearer.
  const env = {
    ACC_PRODUCT_CONFIG_V3: JSON.stringify(native), ACC_PRODUCT_CONFIG_PATH: '',
    CODEBUDDY_DISABLE_CUSTOM_MODELS_FILE: '1', CODEBUDDY_RESPONSES_STORE_ENABLED: 'false',
    // Native ProductManager otherwise persists the merged model.apiKey in its cache.
    CODEBUDDY_DISABLE_PRODUCT_CACHE: '1',
    CODEBUDDY_CODE_MAX_OUTPUT_TOKENS: '',
    CODEBUDDY_AUTH_TOKEN: '', CODEBUDDY_API_KEY: '', CODEBUDDY_BASE_URL: '',
    CODEBUDDY_CUSTOM_HEADERS: customHeaders,
  };
  return { env, args: ['--model', modelId], settings: { alwaysThinkingEnabled: true as const,
    env: { CODEBUDDY_CUSTOM_HEADERS: customHeaders } }, models: {
    catalogConfidence: 'account_unverified',
    projectModel: (_raw, normalized) => normalized,
    projectModelState: ({ normalizedModelState }) => ({ ...normalizedModelState,
      availableModels: normalizedModelState.availableModels.filter((model) => model.id === modelId) }),
    resolveModelUpdate: ({ modelId: requested }) => {
      if (requested !== modelId) throw new PluginError({ code: 'codebuddy_subscription_model_restart_required',
        message: 'Restart CodeBuddy with the selected model to change models.', details: { status: 'requires_restart' } });
      return { modelId };
    },
  } satisfies AgentAcpModelControls };
}

export function createCodeBuddySubscriptionLaunch(configuration: ReturnType<typeof buildCodeBuddyNativeConfiguration>) {
  const directory = createSecureTempDirectorySync({ prefix: 'codebuddy-subscription-settings' });
  try {
    const path = writeSecureTempTextFileSync({ prefix: 'settings', suffix: '.json',
      tmpDir: directory.path, contents: JSON.stringify(configuration.settings) });
    return { env: configuration.env, models: configuration.models,
      args: [...configuration.args, '--settings', path], dispose: () => directory.cleanup() };
  } catch (error) { directory.cleanup(); throw error; }
}

export async function prepareCodeBuddyConnectedAccount(
  request: Readonly<{ modelId?: string | null; providerBinding?: AgentSessionOpenRequest['providerBinding'] }>,
  context: Readonly<{ services: { connectedAccounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> }; signal?: AbortSignal }>,
): Promise<ReturnType<typeof createCodeBuddySubscriptionLaunch> | null> {
  const accounts = context.services.connectedAccounts;
  const selectedKeys = [];
  for (const row of CODEBUDDY_KEY_ACCOUNTS) {
    const selected = await accounts.getBinding(row.purpose, { signal: context.signal });
    if (selected) selectedKeys.push({ row, binding: selected });
  }
  const selectedKey = selectedKeys[0];
  if (!selectedKey) return null;
  if (selectedKeys.length > 1) refuse('codebuddy_connected_account_conflict', 'Select one connected model account for CodeBuddy.');
  if (request.providerBinding) refuse('codebuddy_subscription_provider_conflict', 'Select either a connected model account or a Provider connection for CodeBuddy.');
  const modelId = request.modelId?.trim();
  if (!modelId || modelId === 'default') {
    modelSelectionRequired();
  }
  const { row } = selectedKey;
  const materialized = await accounts.materialize(row.purpose, { kind: 'environment',
    keys: [row.key, ...(row.baseKey ? [row.baseKey] : [])] }, { signal: context.signal, expectedAccount: selectedKey.binding.account });
  if (materialized.kind !== 'environment') refuse('codebuddy_key_materialization_invalid', 'The selected account did not supply an API key.');
  const key = materialized.env[row.key];
  const base = row.baseKey ? materialized.env[row.baseKey] : row.base;
  if (!key || !base) refuse('codebuddy_key_materialization_invalid', 'The selected account did not supply its API key and endpoint.');
  return createCodeBuddySubscriptionLaunch(buildCodeBuddyNativeConfiguration({ modelId,
    api: 'openai-completions', url: `${base.replace(/\/+$/, '')}/chat/completions`, apiKey: key, customHeaders: '' }));
}

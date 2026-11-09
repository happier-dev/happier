import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpModelControls, AgentRuntimeContext, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export const CODEBUDDY_CODEX_PURPOSE = 'openai-codex-model-request';

function refuse(code: string, message: string): never {
  throw new PluginError({ code, message });
}

export function buildCodeBuddySubscriptionConfiguration(input: Readonly<{
  modelId: string | null | undefined;
  materialized: ConnectedAccountMaterialization;
}>): Readonly<{ env: Readonly<Record<string, string>>; args: readonly string[];
  settings: Readonly<{ alwaysThinkingEnabled: true; env: Readonly<{ CODEBUDDY_CUSTOM_HEADERS: string }> }>;
  models: AgentAcpModelControls }> {
  const modelId = input.modelId?.trim();
  if (!modelId) refuse('codebuddy_subscription_model_required', 'Select an explicit ChatGPT model before starting CodeBuddy.');
  if (input.materialized.kind !== 'httpHeaders') refuse('codebuddy_subscription_materialization_invalid', 'CodeBuddy requires access-only ChatGPT HTTP headers.');
  const headers = Object.fromEntries(Object.entries(input.materialized.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const authorization = headers.authorization;
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim() || !headers['chatgpt-account-id']
    || Object.values(headers).some((value) => /[\r\n]/.test(value))) {
    refuse('codebuddy_subscription_materialization_invalid', 'The selected ChatGPT account did not supply its access token and account identity.');
  }
  // CodeBuddy 2.181.0 EnvProductProvider accepts this per-process overlay. The
  // custom tag disables catalogue max-token/temperature fallbacks; omitting
  // maxOutputTokens makes configureModelConfig delete maxTokens before the
  // Responses serializer. No native home or credential file is replaced.
  const native = { productFeatures: { ResponsesStore: false }, models: [{ id: modelId, name: modelId, tags: ['custom'],
    api: 'openai-codex-responses', url: 'https://chatgpt.com/backend-api/codex',
    apiKey: authorization.slice(7), supportsToolCall: true, supportsReasoning: true }] };
  // Explicit settings override saved settings.env. Native logs the settings
  // object, so only noncredential headers go here. Native model.apiKey applies
  // Authorization after custom headers and retains the access-only bearer.
  const customHeaders = Object.entries({ 'chatgpt-account-id': headers['chatgpt-account-id'],
    'openai-beta': 'responses=experimental', originator: 'codex_cli_rs', accept: 'text/event-stream' })
    .map(([key, value]) => `${key}: ${value}`).join('\n');
  const env = {
    ACC_PRODUCT_CONFIG_V3: JSON.stringify(native), ACC_PRODUCT_CONFIG_PATH: '',
    CODEBUDDY_DISABLE_CUSTOM_MODELS_FILE: '1', CODEBUDDY_RESPONSES_STORE_ENABLED: 'false',
    // Native ProductManager otherwise persists the merged model.apiKey in its cache.
    CODEBUDDY_DISABLE_PRODUCT_CACHE: '1',
    CODEBUDDY_CODE_MAX_OUTPUT_TOKENS: '',
    CODEBUDDY_AUTH_TOKEN: '', CODEBUDDY_API_KEY: '', CODEBUDDY_BASE_URL: '',
    CODEBUDDY_CUSTOM_HEADERS: customHeaders,
  };
  return { env, args: ['--model', modelId], settings: { alwaysThinkingEnabled: true,
    env: { CODEBUDDY_CUSTOM_HEADERS: customHeaders } }, models: {
    projectModel: (_raw, normalized) => normalized,
    projectModelState: ({ normalizedModelState }) => ({ ...normalizedModelState,
      availableModels: normalizedModelState.availableModels.filter((model) => model.id === modelId) }),
    resolveModelUpdate: ({ modelId: requested }) => {
      if (requested !== modelId) refuse('codebuddy_subscription_model_restart_required', 'Restart CodeBuddy with the selected ChatGPT model to change models.');
      return { modelId };
    },
  } };
}

export function createCodeBuddySubscriptionLaunch(configuration: ReturnType<typeof buildCodeBuddySubscriptionConfiguration>) {
  const directory = createSecureTempDirectorySync({ prefix: 'codebuddy-subscription-settings' });
  try {
    const path = writeSecureTempTextFileSync({ prefix: 'settings', suffix: '.json',
      tmpDir: directory.path, contents: JSON.stringify(configuration.settings) });
    return { env: configuration.env, models: configuration.models,
      args: [...configuration.args, '--settings', path], dispose: () => directory.cleanup() };
  } catch (error) { directory.cleanup(); throw error; }
}

export async function prepareCodeBuddyConnectedAccount(
  request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>,
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
): Promise<ReturnType<typeof createCodeBuddySubscriptionLaunch> | null> {
  const accounts = context.services.connectedAccounts;
  const binding = await accounts.getBinding(CODEBUDDY_CODEX_PURPOSE, { signal: context.signal });
  if (!binding) return null;
  if (request.providerBinding) refuse('codebuddy_subscription_provider_conflict', 'Select either a Connected ChatGPT account or a Provider connection for CodeBuddy.');
  if (request.configuration?.model.selectionSource !== 'explicit') {
    refuse('codebuddy_subscription_model_required', 'Select an explicit ChatGPT model before starting CodeBuddy.');
  }
  const materialized = await accounts.materialize(CODEBUDDY_CODEX_PURPOSE, {
    kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'],
  }, { signal: context.signal, expectedAccount: binding.account });
  return createCodeBuddySubscriptionLaunch(buildCodeBuddySubscriptionConfiguration({ modelId: request.configuration.model.value, materialized }));
}

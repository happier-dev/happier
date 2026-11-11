import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCodeBuddyNativeConfiguration } from '../runtime/connectedAccounts.js';

export const CODEBUDDY_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_PATH', 'CODEBUDDY_DISABLE_CUSTOM_MODELS_FILE',
  'CODEBUDDY_RESPONSES_STORE_ENABLED', 'CODEBUDDY_DISABLE_PRODUCT_CACHE', 'CODEBUDDY_CODE_MAX_OUTPUT_TOKENS',
  'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_CUSTOM_HEADERS',
] as const);

function serializePublicHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\\ ');
}

function resolveCredential(input: AgentProviderBindingMaterializeInput): string | null {
  const protocol = input.binding.endpoint.protocol;
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('CodeBuddy Provider credential does not match its selected transport');
    }
    if (protocol !== 'openai-chat') {
      throw new Error('CodeBuddy Responses Provider binding requires a credential');
    }
    return null;
  }
  const { transport, value } = input.credential;
  if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
    || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader'
    || transport.destination.name.toLowerCase() !== 'authorization'
    || transport.destination.format !== 'bearer') {
    throw new Error('CodeBuddy Provider binding supports only Authorization bearer credentials');
  }
  const credentialHeader = transport.destination.name.toLowerCase();
  if (Object.keys(input.binding.endpoint.publicHeaders).some(name => name.toLowerCase() === credentialHeader)) {
    throw new Error('CodeBuddy public header competes with the credential destination');
  }
  return value;
}

export const CODEBUDDY_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    const protocol = input.binding.endpoint.protocol;
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses') {
      throw new Error('CodeBuddy Provider binding supports only OpenAI Chat or Responses');
    }
    if (input.prepared.materialization !== 'spawnEnv') {
      throw new Error('CodeBuddy Provider binding requires a spawn environment');
    }
    const credential = resolveCredential(input);
    const baseUrl = input.binding.endpoint.normalizedUrl.replace(/\/+$/u, '');
    const api = protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions';
    const url = `${baseUrl}${protocol === 'openai-responses' ? '/responses' : '/chat/completions'}`;
    const configuration = buildCodeBuddyNativeConfiguration({
      modelId: input.binding.selection.model.id,
      api,
      url,
      customHeaders: serializePublicHeaders(input.binding.endpoint.publicHeaders),
      ...(input.binding.selection.model.capabilities?.reasoningControls === 'supported' ? { supportsReasoning: true as const } : {}),
    });
    const values: Readonly<Record<string, string | null>> = {
      ...configuration.env,
      CODEBUDDY_API_KEY: credential,
    };
    return {
      v: 1 as const,
      kind: 'spawnEnv' as const,
      env: CODEBUDDY_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: values[name] ?? null, source: 'provider' as const })),
    };
  },
} satisfies AgentProviderBindingAdapter);

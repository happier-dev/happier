import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const COPILOT_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  'COPILOT_PROVIDERS_CONFIG',
  'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_MODEL',
  'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_WIRE_API', 'COPILOT_PROVIDER_WIRE_MODEL', 'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_AZURE_API_VERSION', 'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
] as const);

async function materialize(input: AgentProviderBindingMaterializeInput) {
  const protocol = input.binding.endpoint.protocol;
  if (input.prepared.materialization !== 'spawnEnv' || (protocol !== 'openai-chat' && protocol !== 'anthropic')) {
    throw new Error('Copilot Provider binding requires OpenAI Chat or Anthropic and a spawn environment');
  }
  if (Object.keys(input.binding.endpoint.publicHeaders).length) {
    throw new Error('Copilot Provider binding cannot preserve custom public headers');
  }
  const values: Record<string, string | null> = {
    COPILOT_PROVIDER_BASE_URL: input.binding.endpoint.normalizedUrl,
    COPILOT_PROVIDER_TYPE: protocol === 'anthropic' ? 'anthropic' : 'openai',
    COPILOT_MODEL: input.binding.selection.model.id,
  };
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Copilot Provider binding requires its selected credential');
    }
  } else {
    const { transport, value } = input.credential;
    if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
      || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
      || transport.destination.kind !== 'httpHeader') {
      throw new Error('Copilot Provider binding credential does not match its selected transport');
    }
    const header = transport.destination.name.toLowerCase();
    if (header === 'authorization' && transport.destination.format === 'bearer') {
      values.COPILOT_PROVIDER_BEARER_TOKEN = value;
    } else if (protocol === 'anthropic' && header === 'x-api-key' && transport.destination.format === 'raw') {
      values.COPILOT_PROVIDER_API_KEY = value;
    } else {
      throw new Error('Copilot Provider binding does not support this credential transport');
    }
  }
  return { v: 1 as const, kind: 'spawnEnv' as const,
    env: COPILOT_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: values[name] ?? null, source: 'provider' as const })) };
}

/** GitHub Copilot CLI's documented BYOK controls apply only to this process. */
export const COPILOT_PROVIDER_BINDING_ADAPTER_V1: AgentProviderBindingAdapter = Object.freeze({
  v: 1, adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
  materialize,
});

import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const GROK_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_GROK_PROVIDER_API_KEY';
export const GROK_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  'GROK_CONFIG',
  GROK_PROVIDER_SECRET_ENV_KEY,
  'XAI_API_KEY',
] as const);

function validateCredential(input: AgentProviderBindingMaterializeInput): string {
  if (input.credential.kind !== 'apiKey') throw new Error('Grok Provider binding requires an API key');
  const { transport, value } = input.credential;
  if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
    || !transport.protocols.includes('openai-chat') || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader'
    || transport.destination.name.toLowerCase() !== 'authorization'
    || transport.destination.format !== 'bearer') {
    throw new Error('Grok Provider binding supports only Authorization bearer credentials');
  }
  return value;
}

export const GROK_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    if (input.prepared.materialization !== 'spawnEnv' || input.binding.endpoint.protocol !== 'openai-chat') {
      throw new Error('Grok Provider binding requires an OpenAI Chat endpoint and spawn environment');
    }
    if (Object.keys(input.binding.endpoint.publicHeaders).length > 0) {
      throw new Error('Grok Provider binding cannot preserve custom public headers');
    }
    const secret = validateCredential(input);
    const modelId = input.binding.selection.model.id;
    const config = {
      model: {
        [modelId]: {
          model: modelId,
          base_url: input.binding.endpoint.normalizedUrl,
          env_key: GROK_PROVIDER_SECRET_ENV_KEY,
        },
      },
    };
    return {
      v: 1 as const,
      kind: 'spawnEnv' as const,
      env: GROK_PROVIDER_OWNED_ENV_KEYS.map(name => ({
        name,
        value: name === 'GROK_CONFIG' ? JSON.stringify(config) : name === GROK_PROVIDER_SECRET_ENV_KEY ? secret : null,
        source: 'provider' as const,
      })),
    };
  },
} satisfies AgentProviderBindingAdapter);

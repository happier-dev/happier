import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const KIMI_PROVIDER_SECRET_ENV = 'HAPPIER_KIMI_PROVIDER_API_KEY';
export const KIMI_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  KIMI_PROVIDER_SECRET_ENV,
  'HAPPIER_KIMI_ACCESS_TOKEN',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_CODE_BASE_URL',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_OAUTH_HOST',
] as const);

const PROVIDER_BY_PROTOCOL = {
  'openai-chat': 'openai',
  'openai-responses': 'openai_responses',
  anthropic: 'anthropic',
} as const;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function providerConfig(input: AgentProviderBindingMaterializeInput, providerType: string): string {
  const model = input.binding.selection.model;
  const contextWindowTokens = model.contextWindowTokens;
  if (contextWindowTokens === undefined) throw new Error('Kimi Provider binding requires the selected model context window');
  const providerId = 'happier-provider';
  const modelId = model.id;
  const lines = [
    `default_model = ${tomlString(modelId)}`,
    '',
    `[providers.${tomlString(providerId)}]`,
    `type = ${tomlString(providerType)}`,
    `base_url = ${tomlString(input.binding.endpoint.normalizedUrl)}`,
    `api_key_env = ${tomlString(KIMI_PROVIDER_SECRET_ENV)}`,
  ];
  const headers = Object.entries(input.binding.endpoint.publicHeaders);
  if (headers.length > 0) {
    lines.push('', `[providers.${tomlString(providerId)}.custom_headers]`);
    for (const [name, value] of headers) lines.push(`${tomlString(name)} = ${tomlString(value)}`);
  }
  lines.push('', `[models.${tomlString(modelId)}]`, `provider = ${tomlString(providerId)}`, `model = ${tomlString(modelId)}`,
    `display_name = ${tomlString(model.name)}`, `max_context_size = ${String(contextWindowTokens)}`);
  if (input.binding.endpoint.protocol === 'openai-responses') lines.push('protocol = "openai_responses"');
  return `${lines.join('\n')}\n`;
}

function validateCredential(input: AgentProviderBindingMaterializeInput): string {
  if (input.credential.kind !== 'apiKey') throw new Error('Kimi Provider binding requires an API key');
  const { transport, value } = input.credential;
  const destination = transport.destination;
  const protocol = input.binding.endpoint.protocol;
  const expectedDestination = protocol === 'anthropic'
    ? destination.kind === 'httpHeader' && destination.name.toLowerCase() === 'x-api-key' && destination.format === 'raw'
    : destination.kind === 'httpHeader' && destination.name.toLowerCase() === 'authorization' && destination.format === 'bearer';
  if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
    || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime') || !expectedDestination) {
    throw new Error('Kimi Provider binding does not support this credential transport');
  }
  return value;
}

export const KIMI_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'configFile' as const }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    const protocol = input.binding.endpoint.protocol;
    const providerType = PROVIDER_BY_PROTOCOL[protocol as keyof typeof PROVIDER_BY_PROTOCOL];
    if (!providerType) throw new Error('Kimi Provider binding does not support this wire protocol');
    if (input.prepared.materialization !== 'configFile') throw new Error('Kimi requires a native config file');
    const publicHeaders = Object.keys(input.binding.endpoint.publicHeaders);
    if (publicHeaders.some(name => ['authorization', 'x-api-key'].includes(name.toLowerCase()))) {
      throw new Error('Kimi Provider public header competes with its credential');
    }
    const secret = validateCredential(input);
    return {
      v: 1 as const,
      kind: 'configFile' as const,
      nativeHome: true as const,
      env: KIMI_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: name === KIMI_PROVIDER_SECRET_ENV ? secret : null, source: 'provider' as const })),
      files: [{ relativePath: 'config.toml', utf8: providerConfig(input, providerType) }],
    };
  },
} satisfies AgentProviderBindingAdapter);

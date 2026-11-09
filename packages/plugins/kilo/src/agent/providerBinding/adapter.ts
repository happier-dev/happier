import { createHash } from 'node:crypto';

import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

const SECRET_ENV_KEY = 'HAPPIER_KILO_PROVIDER_API_KEY';
const DRIVERS = {
  'openai-chat': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
} as const;

export const KILO_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  SECRET_ENV_KEY, 'KILO_CONFIG_CONTENT', 'KILO_AUTH_CONTENT',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
] as const);

function bindingKey(input: Readonly<{ bindingKey?: string; connectionId?: string }>): string {
  const key = input.bindingKey ?? input.connectionId;
  if (!key) throw new Error('Kilo provider binding requires a source binding key');
  return key;
}

function providerKey(agentTargetKey: string, sourceKey: string): string {
  return `happier_${createHash('sha256').update('happier.kilo.provider-binding.v1\0')
    .update(agentTargetKey).update('\0').update(sourceKey).digest('hex').slice(0, 32)}`;
}

function prepare(input: AgentProviderBindingPrepareInput) {
  return { v: 1, materialization: 'spawnEnv',
    adapterBindingKey: providerKey(input.agentTargetKey, bindingKey(input)) } as const;
}

function credentialValue(input: AgentProviderBindingMaterializeInput): string | null {
  const protocol = input.binding.endpoint.protocol;
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Kilo provider credential does not match its selected transport');
    }
    // Responses and Anthropic SDKs require a key; the compatible Chat SDK can omit it.
    if (protocol !== 'openai-chat') throw new Error('Kilo cannot drive this wire protocol without a credential');
    return null;
  }
  const { transport, value } = input.credential;
  const destination = transport.destination;
  const anthropic = protocol === 'anthropic';
  if (!value || JSON.stringify(input.binding.runtimeCredentialTransport) !== JSON.stringify(transport)
    || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
    || destination.kind !== 'httpHeader'
    || destination.name.toLowerCase() !== (anthropic ? 'x-api-key' : 'authorization')
    || destination.format !== (anthropic ? 'raw' : 'bearer')) {
    throw new Error('Kilo provider binding does not support this credential transport');
  }
  return value;
}

export const KILO_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare,
  materialize(input: AgentProviderBindingMaterializeInput) {
    const key = providerKey(input.binding.agentTargetKey, bindingKey(input.binding.selection));
    if (input.prepared.materialization !== 'spawnEnv' || input.prepared.adapterBindingKey !== key) {
      throw new Error('Kilo provider binding preparation does not match the resolved connection');
    }
    const protocol = input.binding.endpoint.protocol;
    if (!Object.hasOwn(DRIVERS, protocol)) throw new Error('Kilo provider binding does not support this wire protocol');
    const npm = DRIVERS[protocol as keyof typeof DRIVERS];
    const secret = credentialValue(input);
    const headers = input.binding.endpoint.publicHeaders;
    // Trusted Kilo config expands these tokens before JSON parsing, including
    // in model catalog text and headers supplied by an upstream Provider.
    const publicConfig = JSON.stringify({ modelId: input.binding.selection.model.id, modelName: input.binding.selection.model.name,
      baseURL: input.binding.endpoint.normalizedUrl, headers });
    if (/\{(?:env|file):/u.test(publicConfig)) {
      throw new Error('Kilo Provider data cannot contain native config substitutions');
    }
    if (Object.keys(headers).some(name => ['authorization', 'x-api-key'].includes(name.toLowerCase()))) {
      throw new Error('A Kilo provider public header competes with the credential destination');
    }
    // KILO_CONFIG_CONTENT is trusted native configuration, so {env:...} expands
    // inside the child. No credential enters a native config or auth file.
    const config = JSON.stringify({
      enabled_providers: [key],
      model: `${key}/${input.binding.selection.model.id}`,
      provider: { [key]: {
        npm, name: 'Happier provider',
        options: { baseURL: input.binding.endpoint.normalizedUrl,
          ...(secret ? { apiKey: `{env:${SECRET_ENV_KEY}}` } : {}),
          ...(Object.keys(headers).length ? { headers } : {}) },
        models: { [input.binding.selection.model.id]: { name: input.binding.selection.model.name } },
      } },
    });
    return { v: 1, kind: 'spawnEnv', env: KILO_PROVIDER_OWNED_ENV_KEYS.map(name => ({
      name, source: 'provider' as const,
      value: name === SECRET_ENV_KEY ? secret
        : name === 'KILO_CONFIG_CONTENT' ? config
          : name === 'KILO_AUTH_CONTENT' ? '{}' : null,
    })) } as const;
  },
} satisfies AgentProviderBindingAdapter);

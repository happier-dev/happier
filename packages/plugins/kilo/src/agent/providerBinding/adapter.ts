import { createHash } from 'node:crypto';

import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

export const KILO_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_KILO_PROVIDER_API_KEY';
const KILO_PROVIDER_ANTHROPIC_SECRET_ENV_KEY = 'HAPPIER_KILO_PROVIDER_ANTHROPIC_API_KEY';
const DRIVERS = {
  'openai-chat': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
} as const;

export const KILO_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  KILO_PROVIDER_SECRET_ENV_KEY, 'KILO_CONFIG_CONTENT', 'KILO_AUTH_CONTENT',
  KILO_PROVIDER_ANTHROPIC_SECRET_ENV_KEY,
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

function credentialValue(input: AgentProviderBindingMaterializeInput): Readonly<{
  secret: string | null;
  credentialHeaders: Readonly<Record<string, string>>;
  additionalSecrets: Readonly<Record<string, string | null>>;
}> {
  const protocol = input.binding.endpoint.protocol;
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Kilo provider credential does not match its selected transport');
    }
    // Responses and Anthropic SDKs require a key; the compatible Chat SDK can omit it.
    if (protocol !== 'openai-chat') throw new Error('Kilo cannot drive this wire protocol without a credential');
    return { secret: null, credentialHeaders: {}, additionalSecrets: {} };
  }
  const { transport, value } = input.credential;
  const destination = transport.destination;
  if (!value || JSON.stringify(input.binding.runtimeCredentialTransport) !== JSON.stringify(transport)
    || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
    || destination.kind !== 'httpHeader'
    || (destination.format !== 'raw' && destination.format !== 'bearer')) {
    throw new Error('Kilo provider binding does not support this credential transport');
  }
  const additional = input.credential.additionalCredentials ?? [];
  const declared = transport.additionalCredentials ?? [];
  if (additional.length !== declared.length || new Set(additional.map(row => row.slotId)).size !== additional.length) {
    throw new Error('Kilo provider binding companion credentials do not match the selected transport');
  }
  const additionalSecrets: Record<string, string | null> = {};
  const credentialHeaders: Record<string, string> = {};
  const primaryHeader = destination.name.toLowerCase();
  const primaryNative = (protocol === 'anthropic' && primaryHeader === 'x-api-key' && destination.format === 'raw')
    || (protocol !== 'anthropic' && primaryHeader === 'authorization' && destination.format === 'bearer');
  if (!primaryNative) credentialHeaders[destination.name] = `{env:${KILO_PROVIDER_SECRET_ENV_KEY}}`;
  for (const row of declared) {
    const supplied = additional.find(candidate => candidate.slotId === row.slotId);
    if (!supplied || !supplied.value || row.destination.kind !== 'httpHeader'
      || (row.destination.format !== 'raw' && row.destination.format !== 'bearer')
      || row.slotId !== 'anthropicApiKey') {
      throw new Error('Kilo provider binding companion credential is unsupported');
    }
    additionalSecrets[row.slotId] = supplied.value;
    credentialHeaders[row.destination.name] = `{env:${KILO_PROVIDER_ANTHROPIC_SECRET_ENV_KEY}}`;
  }
  return { secret: value, credentialHeaders, additionalSecrets };
}

export function buildKiloNativeUpstreamConfig({ key, npm, model, baseURL, headers = {}, hasCredential, credentialHeaderNames = [] }: Readonly<{
  key: string; npm: string; model?: Readonly<{ id: string; name: string }>; baseURL: string;
  headers?: Readonly<Record<string, string>>; hasCredential: boolean;
  credentialHeaderNames?: readonly string[];
}>): string {
    // Trusted Kilo config expands these tokens before JSON parsing, including
    // in model catalog text and headers supplied by an upstream Provider.
    const credentialHeaderNameSet = new Set(credentialHeaderNames.map(name => name.toLowerCase()));
    const literalConfig = JSON.stringify({ modelId: model?.id, modelName: model?.name, baseURL });
    if (/\{(?:env|file):/u.test(literalConfig)
      || Object.entries(headers).some(([name, value]) => !credentialHeaderNameSet.has(name.toLowerCase()) && /\{(?:env|file):/u.test(value))) {
      throw new Error('Kilo Provider data cannot contain native config substitutions');
    }
    if (Object.keys(headers).some(name => !credentialHeaderNameSet.has(name.toLowerCase())
      && ['authorization', 'x-api-key'].includes(name.toLowerCase()))) {
      throw new Error('A Kilo provider public header competes with the credential destination');
    }
    // KILO_CONFIG_CONTENT is trusted native configuration, so {env:...} expands
    // inside the child. No credential enters a native config or auth file.
    return JSON.stringify({
      enabled_providers: [key],
      ...(model ? { model: `${key}/${model.id}` } : {}),
      provider: { [key]: {
        npm, name: 'Happier provider',
        options: { baseURL: baseURL,
          ...(hasCredential ? { apiKey: `{env:${KILO_PROVIDER_SECRET_ENV_KEY}}` } : {}),
          ...(Object.keys(headers).length ? { headers } : {}) },
        ...(model ? { models: { [model.id]: { name: model.name } } } : {}),
      } },
    });
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
    const credential = credentialValue(input);
    const headers = { ...input.binding.endpoint.publicHeaders, ...credential.credentialHeaders };
    const publicHeaderNames = new Set(Object.keys(input.binding.endpoint.publicHeaders).map(name => name.toLowerCase()));
    if (Object.keys(credential.credentialHeaders).some(name => publicHeaderNames.has(name.toLowerCase()))) {
      throw new Error('A Kilo provider public header competes with the credential destination');
    }
    const config = buildKiloNativeUpstreamConfig({ key, npm, model: input.binding.selection.model,
      baseURL: input.binding.endpoint.normalizedUrl, headers,
      hasCredential: Boolean(credential.secret) && Object.keys(credential.credentialHeaders).length === 0,
      credentialHeaderNames: Object.keys(credential.credentialHeaders) });
    return { v: 1, kind: 'spawnEnv', env: KILO_PROVIDER_OWNED_ENV_KEYS.map(name => ({
      name, source: 'provider' as const,
      value: name === KILO_PROVIDER_SECRET_ENV_KEY ? credential.secret
        : name === KILO_PROVIDER_ANTHROPIC_SECRET_ENV_KEY ? credential.additionalSecrets.anthropicApiKey ?? null
        : name === 'KILO_CONFIG_CONTENT' ? config
          : name === 'KILO_AUTH_CONTENT' ? '{}' : null,
    })) } as const;
  },
} satisfies AgentProviderBindingAdapter);

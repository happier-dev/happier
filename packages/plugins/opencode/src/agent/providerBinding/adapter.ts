import { createHash } from 'node:crypto';

import type {
  AgentProviderBindingAdapterV1,
  AgentProviderBindingMaterializeInputV1,
  AgentProviderBindingPrepareInputV1,
  AgentProviderBindingPreparedV1,
} from '@happier-dev/plugin-sdk';

type ProviderBindingMaterialization = Awaited<ReturnType<AgentProviderBindingAdapterV1['materialize']>>;
type ProviderBindingEnvOverlay = Extract<ProviderBindingMaterialization, { kind: 'configFile' }>['env'];
type ProviderCredentialTransport = NonNullable<
  AgentProviderBindingMaterializeInputV1['binding']['runtimeCredentialTransport']
>;

const OPENCODE_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_OPENCODE_PROVIDER_API_KEY';
export const OPENCODE_PROVIDER_BINDING_ADAPTER_VERSION_V1 = 1;

export const OPENCODE_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  OPENCODE_PROVIDER_SECRET_ENV_KEY,
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG_CONTENT',
] as const);

const DRIVER_BY_PROTOCOL = Object.freeze({
  'openai-responses': '@ai-sdk/openai',
  'openai-chat': '@ai-sdk/openai-compatible',
} as const);

type SupportedProtocol = keyof typeof DRIVER_BY_PROTOCOL;

function createOpenCodeProviderKey(input: Readonly<{
  agentTargetKey: string;
  connectionId: string;
}>): string {
  const digest = createHash('sha256')
    .update('happier.opencode.provider-binding.v1\0', 'utf8')
    .update(input.agentTargetKey, 'utf8')
    .update('\0', 'utf8')
    .update(input.connectionId, 'utf8')
    .update(`\0adapter-version:${OPENCODE_PROVIDER_BINDING_ADAPTER_VERSION_V1}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `happier_${digest}`;
}

function prepareOpenCodeProviderBindingV1(
  input: AgentProviderBindingPrepareInputV1,
): AgentProviderBindingPreparedV1 {
  return {
    v: 1,
    materialization: 'configFile',
    adapterBindingKey: createOpenCodeProviderKey(input),
  };
}

function assertPreparedBindingMatches(input: AgentProviderBindingMaterializeInputV1): string {
  const expected = createOpenCodeProviderKey({
    agentTargetKey: input.binding.agentTargetKey,
    connectionId: input.binding.selection.connectionId,
  });
  if (input.prepared.materialization !== 'configFile'
    || input.prepared.adapterBindingKey !== expected) {
    throw new Error('OpenCode provider binding preparation does not match the resolved connection');
  }
  return expected;
}

function isSupportedProtocol(protocol: string): protocol is SupportedProtocol {
  return Object.prototype.hasOwnProperty.call(DRIVER_BY_PROTOCOL, protocol);
}

function transportsEqual(
  left: ProviderCredentialTransport | null,
  right: ProviderCredentialTransport,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).sort(([left], [right]) => compareText(left, right)));
}

function resolveCredentialOptions(input: AgentProviderBindingMaterializeInputV1): Readonly<{
  secretValue: string | null;
  apiKey?: string;
  header?: Readonly<{ name: string; value: string }>;
  additionalRedactionValues?: string[];
}> {
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('OpenCode provider binding credential does not match its selected transport');
    }
    return { secretValue: null };
  }

  const { transport, value } = input.credential;
  if (!value || !transportsEqual(input.binding.runtimeCredentialTransport, transport)) {
    throw new Error('OpenCode provider binding credential does not match its selected transport');
  }
  if (!isSupportedProtocol(input.binding.endpoint.protocol)
    || !transport.protocols.includes(input.binding.endpoint.protocol)
    || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader'
    || (transport.destination.format !== 'raw' && transport.destination.format !== 'bearer')) {
    throw new Error('OpenCode provider binding does not support this credential transport');
  }

  const envReference = `{env:${OPENCODE_PROVIDER_SECRET_ENV_KEY}}`;
  if (transport.destination.name.toLowerCase() === 'authorization'
    && transport.destination.format === 'bearer') {
    return { secretValue: value, apiKey: envReference };
  }
  const renderedReference = transport.destination.format === 'bearer'
    ? `Bearer ${envReference}`
    : envReference;
  return {
    secretValue: value,
    header: { name: transport.destination.name, value: renderedReference },
    ...(transport.destination.format === 'bearer'
      ? { additionalRedactionValues: [`Bearer ${value}`] }
      : {}),
  };
}

function buildOwnedEnvironment(secretValue: string | null): ProviderBindingEnvOverlay {
  return OPENCODE_PROVIDER_OWNED_ENV_KEYS.map((name) => ({
    name,
    value: name === OPENCODE_PROVIDER_SECRET_ENV_KEY ? secretValue : null,
    source: 'provider' as const,
  }));
}

async function materializeOpenCodeProviderBindingV1(
  input: AgentProviderBindingMaterializeInputV1,
): Promise<ProviderBindingMaterialization> {
  const adapterBindingKey = assertPreparedBindingMatches(input);
  const protocol = input.binding.endpoint.protocol;
  if (!isSupportedProtocol(protocol)) {
    throw new Error('OpenCode provider binding does not support this wire protocol');
  }
  const credential = resolveCredentialOptions(input);
  const headers = sortHeaders(input.binding.endpoint.publicHeaders);
  if (credential.header) {
    const credentialName = credential.header.name.toLowerCase();
    if (Object.keys(headers).some((name) => name.toLowerCase() === credentialName)) {
      throw new Error('An OpenCode provider public header competes with the credential destination');
    }
    headers[credential.header.name] = credential.header.value;
  }

  const options = {
    baseURL: input.binding.endpoint.normalizedUrl,
    ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  const config = {
    $schema: 'https://opencode.ai/config.json',
    enabled_providers: [adapterBindingKey],
    model: `${adapterBindingKey}/${input.binding.selection.modelId}`,
    provider: {
      [adapterBindingKey]: {
        npm: DRIVER_BY_PROTOCOL[protocol],
        name: 'Happier provider',
        options,
        models: {
          [input.binding.selection.modelId]: { name: input.binding.selection.modelId },
        },
      },
    },
  };

  return {
    v: 1,
    kind: 'configFile',
    env: buildOwnedEnvironment(credential.secretValue),
    files: [{
      relativePath: 'opencode/opencode.json',
      utf8: `${JSON.stringify(config, null, 2)}\n`,
    }],
    ...(credential.additionalRedactionValues
      ? { additionalRedactionValues: credential.additionalRedactionValues }
      : {}),
  };
}

export const OPENCODE_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: OPENCODE_PROVIDER_BINDING_ADAPTER_VERSION_V1,
  prepare: prepareOpenCodeProviderBindingV1,
  materialize: materializeOpenCodeProviderBindingV1,
} satisfies AgentProviderBindingAdapterV1);

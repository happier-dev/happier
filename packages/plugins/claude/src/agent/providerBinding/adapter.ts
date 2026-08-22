import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepared,
} from '@happier-dev/plugin-sdk/agents/runtime';

type ProviderBindingMaterialization = Awaited<ReturnType<AgentProviderBindingAdapter['materialize']>>;
type ProviderBindingEnvOverlay = Extract<ProviderBindingMaterialization, { kind: 'spawnEnv' }>['env'];
type ProviderCredentialTransport = NonNullable<
  AgentProviderBindingMaterializeInput['binding']['runtimeCredentialTransport']
>;

export const CLAUDE_PROVIDER_BINDING_ADAPTER_VERSION_V1 = 2;

export const CLAUDE_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SETUP_TOKEN',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
] as const);

function prepareClaudeProviderBindingV1(): AgentProviderBindingPrepared {
  return { v: 1, materialization: 'spawnEnv' };
}

function transportsEqual(
  left: ProviderCredentialTransport | null,
  right: ProviderCredentialTransport,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function resolveCredential(input: AgentProviderBindingMaterializeInput): Readonly<{
  envKey: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | null;
  value: string | null;
}> {
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Claude provider binding credential does not match its selected transport');
    }
    return { envKey: null, value: null };
  }

  const { transport, value } = input.credential;
  if (!value || !transportsEqual(input.binding.runtimeCredentialTransport, transport)) {
    throw new Error('Claude provider binding credential does not match its selected transport');
  }
  if (!transport.protocols.includes('anthropic')
    || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader') {
    throw new Error('Claude provider binding does not support this credential transport');
  }
  const header = transport.destination.name.toLowerCase();
  if (header === 'authorization' && transport.destination.format === 'bearer') {
    return { envKey: 'ANTHROPIC_AUTH_TOKEN', value };
  }
  if (header === 'x-api-key' && transport.destination.format === 'raw') {
    return { envKey: 'ANTHROPIC_API_KEY', value };
  }
  throw new Error('Claude provider binding does not support this credential transport');
}

function buildOwnedEnvironment(input: Readonly<{
  baseUrl: string;
  customHeaders: string | null;
  credentialKey: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | null;
  credentialValue: string | null;
}>): ProviderBindingEnvOverlay {
  return CLAUDE_PROVIDER_OWNED_ENV_KEYS.map((name) => ({
    name,
    value: name === 'ANTHROPIC_BASE_URL'
      ? input.baseUrl
      : name === 'ANTHROPIC_CUSTOM_HEADERS'
        ? input.customHeaders
      : name === input.credentialKey
        ? input.credentialValue
        : null,
    source: 'provider' as const,
  }));
}

function renderCustomHeaders(headers: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(headers).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return entries.length === 0
    ? null
    : entries.map(([name, value]) => `${name}: ${value}`).join('\n');
}

async function materializeClaudeProviderBindingV1(
  input: AgentProviderBindingMaterializeInput,
): Promise<ProviderBindingMaterialization> {
  if (input.prepared.materialization !== 'spawnEnv'
    || input.prepared.adapterBindingKey !== undefined) {
    throw new Error('Claude provider binding preparation is invalid');
  }
  if (input.binding.endpoint.protocol !== 'anthropic') {
    throw new Error('Claude provider binding supports only the Anthropic protocol');
  }
  const credential = resolveCredential(input);
  return {
    v: 1,
    kind: 'spawnEnv',
    env: buildOwnedEnvironment({
      baseUrl: input.binding.endpoint.normalizedUrl,
      customHeaders: renderCustomHeaders(input.binding.endpoint.publicHeaders),
      credentialKey: credential.envKey,
      credentialValue: credential.value,
    }),
  };
}

export const CLAUDE_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_VERSION_V1,
  prepare: prepareClaudeProviderBindingV1,
  materialize: materializeClaudeProviderBindingV1,
} satisfies AgentProviderBindingAdapter);

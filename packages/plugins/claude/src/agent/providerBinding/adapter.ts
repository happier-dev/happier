import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
  AgentProviderBindingPrepared,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createHash } from 'node:crypto';
import { normalizeProviderCredentialHeaderName } from '@happier-dev/plugin-sdk/providers';

type ProviderBindingMaterialization = Awaited<ReturnType<AgentProviderBindingAdapter['materialize']>>;
type ProviderBindingEnvOverlay = Extract<ProviderBindingMaterialization, { kind: 'spawnEnv' }>['env'];
type ProviderCredentialTransport = NonNullable<
  AgentProviderBindingMaterializeInput['binding']['runtimeCredentialTransport']
>;

export const CLAUDE_PROVIDER_BINDING_ADAPTER_VERSION_V1 = 4;

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

export const CLAUDE_PROVIDER_HELPER_ENV_KEYS = Object.freeze([
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const);

const CLAUDE_PROVIDER_OWNED_ENV_IDENTITIES: ReadonlySet<string> = new Set(
  [...CLAUDE_PROVIDER_OWNED_ENV_KEYS, ...CLAUDE_PROVIDER_HELPER_ENV_KEYS].map((name) => name.toUpperCase()),
);

/**
 * Whether the Provider binding owns this environment name. Environment-variable
 * identity is case-insensitive on Windows, where a mixed-case settings entry
 * reaches the launched process as the same variable, so the binding decides by
 * the same case-folded identity the host uses for unset/overlay keys.
 */
export function isClaudeProviderOwnedEnvName(name: string): boolean {
  return CLAUDE_PROVIDER_OWNED_ENV_IDENTITIES.has(name.toUpperCase());
}

function resolveHelperModelPins(
  modelId: string,
  models: NonNullable<AgentProviderBindingMaterializeInput['binding']['claudeHelperModels']>,
) {
  return {
    fast: models.fast ?? modelId,
    default: models.default ?? modelId,
    strongest: models.strongest ?? modelId,
  };
}

function helperModelBindingKey(
  modelId: string,
  models: NonNullable<AgentProviderBindingMaterializeInput['binding']['claudeHelperModels']>,
): string {
  // The existing binding key participates in host live/restart policy. Pin changes
  // need a new Claude process; model-only changes with identical pins remain live.
  return `claude-helpers-${createHash('sha256').update(JSON.stringify(resolveHelperModelPins(modelId, models))).digest('hex')}`;
}

function prepareClaudeProviderBindingV1(input?: AgentProviderBindingPrepareInput): AgentProviderBindingPrepared {
  if (input?.claudeHelperModels !== undefined && !input.model) {
    throw new Error('Claude helper model preparation requires the selected model');
  }
  return {
    v: 1,
    materialization: 'spawnEnv',
    ...(input?.claudeHelperModels !== undefined && input.model ? {
      adapterBindingKey: helperModelBindingKey(input.model.id, input.claudeHelperModels),
    } : {}),
  };
}

function transportsEqual(
  left: ProviderCredentialTransport | null,
  right: ProviderCredentialTransport,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function resolveCredential(input: AgentProviderBindingMaterializeInput): Readonly<{
  apiKey: string | null;
  authToken: string | null;
  headers: Readonly<Record<string, string>>;
  redactionValues: readonly string[];
}> {
  const headers = { ...input.binding.endpoint.publicHeaders };
  let apiKey: string | null = null;
  let authToken: string | null = null;
  const redactionValues: string[] = [];
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Claude provider binding credential does not match its selected transport');
    }
    return { apiKey, authToken, headers, redactionValues };
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
  const supplied = input.credential.additionalCredentials ?? [];
  const declared = transport.additionalCredentials ?? [];
  if (supplied.length !== declared.length || new Set(supplied.map(row => row.slotId)).size !== supplied.length) {
    throw new Error('Claude provider binding companion credentials do not match the selected transport');
  }
  const materials = [{ destination: transport.destination, value }, ...declared.map(row => {
    const material = supplied.find(candidate => candidate.slotId === row.slotId);
    if (!material) throw new Error('Claude provider binding companion credential is missing');
    return { destination: row.destination, value: material.value };
  })];
  const names = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  for (const material of materials) {
    const { destination, value: secret } = material;
    if (destination.kind !== 'httpHeader' || (destination.format !== 'raw' && destination.format !== 'bearer')) {
      throw new Error('Claude provider binding does not support this credential transport');
    }
    const header = normalizeProviderCredentialHeaderName(destination.name);
    if (!secret || /[\u0000-\u001f\u007f]/u.test(secret) || names.has(header)) {
      throw new Error('Claude provider binding credential header is invalid or collides with another header');
    }
    names.add(header);
    const rendered = destination.format === 'bearer' ? `Bearer ${secret}` : secret;
    redactionValues.push(secret, rendered);
    if (header === 'authorization' && destination.format === 'bearer') authToken = secret;
    else if (header === 'x-api-key' && destination.format === 'raw') apiKey = secret;
    else headers[header] = rendered;
  }
  if (!apiKey && !authToken) {
    throw new Error('Claude provider binding requires native startup authentication');
  }
  return { apiKey, authToken, headers, redactionValues };
}

function buildOwnedEnvironment(input: Readonly<{
  baseUrl: string;
  customHeaders: string | null;
  apiKey: string | null;
  authToken: string | null;
  helperModels: AgentProviderBindingMaterializeInput['binding']['claudeHelperModels'];
  sessionModelId: string;
}>): ProviderBindingEnvOverlay {
  const pins = input.helperModels === undefined
    ? null
    : resolveHelperModelPins(input.sessionModelId, input.helperModels);
  const keys = [...CLAUDE_PROVIDER_OWNED_ENV_KEYS, ...(pins ? CLAUDE_PROVIDER_HELPER_ENV_KEYS : [])];
  return keys.map((name) => ({
    name,
    value: name === 'ANTHROPIC_BASE_URL'
      ? input.baseUrl
      : name === 'ANTHROPIC_CUSTOM_HEADERS'
        ? input.customHeaders
      : name === 'ANTHROPIC_API_KEY'
        ? input.apiKey
      : name === 'ANTHROPIC_AUTH_TOKEN'
        ? input.authToken
        : name === 'ANTHROPIC_DEFAULT_HAIKU_MODEL' && pins !== null
          ? pins.fast
        : name === 'ANTHROPIC_DEFAULT_SONNET_MODEL' && pins !== null
          ? pins.default
        : name === 'ANTHROPIC_DEFAULT_OPUS_MODEL' && pins !== null
          ? pins.strongest
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
  const expectedKey = input.binding.claudeHelperModels === undefined
    ? undefined
    : helperModelBindingKey(input.binding.selection.model.id, input.binding.claudeHelperModels);
  if (input.prepared.materialization !== 'spawnEnv'
    || input.prepared.adapterBindingKey !== expectedKey) {
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
      customHeaders: renderCustomHeaders(credential.headers),
      apiKey: credential.apiKey,
      authToken: credential.authToken,
      helperModels: input.binding.claudeHelperModels,
      sessionModelId: input.binding.selection.model.id,
    }),
    ...(credential.redactionValues.length ? { additionalRedactionValues: credential.redactionValues } : {}),
  };
}

export const CLAUDE_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_VERSION_V1,
  supportsClaudeHelperModels: true,
  prepare: prepareClaudeProviderBindingV1,
  materialize: materializeClaudeProviderBindingV1,
} satisfies AgentProviderBindingAdapter);

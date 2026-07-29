import { createHash } from 'node:crypto';

import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
  AgentProviderBindingPrepared,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/plugin-sdk/experimental/providers';

type ProviderBindingMaterialization = Awaited<ReturnType<AgentProviderBindingAdapter['materialize']>>;
type ProviderBindingEnvOverlay = Extract<ProviderBindingMaterialization, { kind: 'engineConfig' }>['env'];

const CODEX_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_CODEX_PROVIDER_API_KEY';
const CODEX_PROVIDER_BINDING_ADAPTER_VERSION_V1 = 1;
const CODEX_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  CODEX_PROVIDER_SECRET_ENV_KEY,
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
] as const);

export const CODEX_PROVIDER_BINDING_ENGINE_CONFIG_FIELDS_V1 = Object.freeze([
  'name',
  'base_url',
  'wire_api',
  'env_key',
  'http_headers',
  'env_http_headers',
  'requires_openai_auth',
  'supports_websockets',
] as const);

type ReservedCodexProvider = Readonly<{
  adapterBindingKey: 'ollama' | 'lmstudio';
  contributionKey: string;
  endpointTemplateId: string;
  normalizedUrl: string;
}>;

const RESERVED_CODEX_PROVIDERS = Object.freeze([
  Object.freeze({
    adapterBindingKey: 'ollama',
    contributionKey: 'happier.provider.ollama/ollama',
    endpointTemplateId: 'ollama-openai-responses',
    normalizedUrl: 'http://localhost:11434/v1',
  }),
  Object.freeze({
    adapterBindingKey: 'lmstudio',
    contributionKey: 'happier.provider.lmstudio/lmstudio',
    endpointTemplateId: 'lmstudio-openai-responses',
    normalizedUrl: 'http://localhost:1234/v1',
  }),
] as const satisfies readonly ReservedCodexProvider[]);

function resolveReservedCodexProvider(input: Readonly<{
  contributionKey: string | null;
  endpointTemplateId: string;
  protocol: string;
  normalizedUrl: string;
}>): ReservedCodexProvider | null {
  if (input.protocol !== 'openai-responses') return null;
  return RESERVED_CODEX_PROVIDERS.find((candidate) => (
    input.contributionKey !== null
    && areProviderContributionKeysEqualV1(candidate.contributionKey, input.contributionKey)
    && candidate.endpointTemplateId === input.endpointTemplateId
    && candidate.normalizedUrl === input.normalizedUrl
  )) ?? null;
}

function createCustomCodexProviderKey(input: Readonly<{
  agentTargetKey: string;
  connectionId: string;
}>): string {
  const digest = createHash('sha256')
    .update('happier.codex.provider-binding.v1\0', 'utf8')
    .update(input.agentTargetKey, 'utf8')
    .update('\0', 'utf8')
    .update(input.connectionId, 'utf8')
    .update(`\0adapter-version:${CODEX_PROVIDER_BINDING_ADAPTER_VERSION_V1}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `happier_${digest}`;
}

function resolvePreparedBindingKey(input: AgentProviderBindingPrepareInput): string {
  const reserved = input.reservedBindingCandidate
    ? resolveReservedCodexProvider({
      contributionKey: input.reservedBindingCandidate.contributionKey,
      endpointTemplateId: input.reservedBindingCandidate.endpointTemplateId,
      protocol: input.reservedBindingCandidate.protocol,
      normalizedUrl: input.reservedBindingCandidate.normalizedUrl,
    })
    : null;
  return reserved?.adapterBindingKey ?? createCustomCodexProviderKey({
    agentTargetKey: input.agentTargetKey,
    connectionId: input.connectionId,
  });
}

function prepareCodexProviderBindingV1(
  input: AgentProviderBindingPrepareInput,
): AgentProviderBindingPrepared {
  return {
    v: 1,
    materialization: 'engineConfig',
    adapterBindingKey: resolvePreparedBindingKey(input),
  };
}

function sortStringRecord(input: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertPreparedBindingMatches(input: AgentProviderBindingMaterializeInput): string {
  if (input.prepared.materialization !== 'engineConfig' || !input.prepared.adapterBindingKey) {
    throw new Error('Codex provider binding requires a prepared engine-config key');
  }
  const reserved = resolveReservedCodexProvider({
    contributionKey: input.binding.contributionKey,
    endpointTemplateId: input.binding.endpoint.endpointTemplateId,
    protocol: input.binding.endpoint.protocol,
    normalizedUrl: input.binding.endpoint.normalizedUrl,
  });
  const expected = reserved?.adapterBindingKey ?? createCustomCodexProviderKey({
    agentTargetKey: input.binding.agentTargetKey,
    connectionId: input.binding.selection.connectionId,
  });
  if (expected !== input.prepared.adapterBindingKey) {
    throw new Error('Codex provider binding preparation does not match the resolved connection');
  }
  return expected;
}

function transportsEqual(
  left: AgentProviderBindingMaterializeInput['binding']['runtimeCredentialTransport'],
  right: Extract<AgentProviderBindingMaterializeInput['credential'], { kind: 'apiKey' }>['transport'],
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function resolveCredentialMaterialization(input: AgentProviderBindingMaterializeInput): Readonly<{
  value: string | null;
  providerFields: Readonly<Record<string, unknown>>;
  additionalRedactionValues?: string[];
}> {
  if (input.credential.kind === 'none') {
    if (input.binding.runtimeCredentialTransport !== null) {
      throw new Error('Codex provider binding credential does not match its selected transport');
    }
    return { value: null, providerFields: {} };
  }

  const { transport, value } = input.credential;
  if (!value || !transportsEqual(input.binding.runtimeCredentialTransport, transport)) {
    throw new Error('Codex provider binding credential does not match its selected transport');
  }
  if (!transport.protocols.includes('openai-responses')
    || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader'
    || (transport.destination.format !== 'raw' && transport.destination.format !== 'bearer')) {
    throw new Error('Codex provider binding does not support this credential transport');
  }

  const headerName = transport.destination.name.toLowerCase();
  if (headerName === 'authorization' && transport.destination.format === 'bearer') {
    return {
      value,
      providerFields: { env_key: CODEX_PROVIDER_SECRET_ENV_KEY },
    };
  }

  const rendered = transport.destination.format === 'bearer' ? `Bearer ${value}` : value;
  return {
    value: rendered,
    providerFields: {
      env_http_headers: { [transport.destination.name]: CODEX_PROVIDER_SECRET_ENV_KEY },
    },
    ...(rendered === value ? {} : { additionalRedactionValues: [rendered] }),
  };
}

function buildOwnedEnvironment(secretValue: string | null): ProviderBindingEnvOverlay {
  return CODEX_PROVIDER_OWNED_ENV_KEYS.map((name) => ({
    name,
    value: name === CODEX_PROVIDER_SECRET_ENV_KEY ? secretValue : null,
    source: 'provider' as const,
  }));
}

function buildModelReasoningConfig(
  input: AgentProviderBindingMaterializeInput,
): Readonly<{ model_reasoning_effort?: 'none' }> {
  return input.binding.selection.model.capabilities?.reasoningControls === 'unsupported'
    ? { model_reasoning_effort: 'none' }
    : {};
}

async function materializeCodexProviderBindingV1(
  input: AgentProviderBindingMaterializeInput,
): Promise<ProviderBindingMaterialization> {
  const adapterBindingKey = assertPreparedBindingMatches(input);
  if (input.binding.endpoint.protocol !== 'openai-responses') {
    throw new Error('Codex provider binding supports only the Responses protocol');
  }

  const reserved = resolveReservedCodexProvider({
    contributionKey: input.binding.contributionKey,
    endpointTemplateId: input.binding.endpoint.endpointTemplateId,
    protocol: input.binding.endpoint.protocol,
    normalizedUrl: input.binding.endpoint.normalizedUrl,
  });
  if (reserved) {
    if (input.credential.kind !== 'none'
      || input.binding.runtimeCredentialTransport !== null
      || Object.keys(input.binding.endpoint.publicHeaders).length > 0) {
      throw new Error('A reserved Codex provider cannot represent custom credentials or headers');
    }
    return {
      v: 1,
      kind: 'engineConfig',
      env: buildOwnedEnvironment(null),
      engineConfig: {
        v: 1,
        modelProvider: adapterBindingKey,
        config: buildModelReasoningConfig(input),
      },
    };
  }

  const credential = resolveCredentialMaterialization(input);
  const publicHeaders = sortStringRecord(input.binding.endpoint.publicHeaders);
  const credentialDestination = input.binding.runtimeCredentialTransport?.destination;
  if (credentialDestination?.kind === 'httpHeader') {
    const credentialHeaderName = credentialDestination.name.toLowerCase();
    if (Object.keys(publicHeaders).some((name) => name.toLowerCase() === credentialHeaderName)) {
      throw new Error('A Codex provider public header competes with the credential destination');
    }
  }
  const providerFields = {
    name: 'Happier provider',
    base_url: input.binding.endpoint.normalizedUrl,
    wire_api: 'responses',
    ...credential.providerFields,
    ...(Object.keys(publicHeaders).length > 0 ? { http_headers: publicHeaders } : {}),
    // These are fixed safe values, not feature toggles exposed to callers.
    requires_openai_auth: false,
    supports_websockets: false,
  } as const;

  return {
    v: 1,
    kind: 'engineConfig',
    env: buildOwnedEnvironment(credential.value),
    engineConfig: {
      v: 1,
      modelProvider: adapterBindingKey,
      config: {
        ...buildModelReasoningConfig(input),
        [`model_providers.${adapterBindingKey}`]: providerFields,
      },
    },
    ...(credential.additionalRedactionValues
      ? { additionalRedactionValues: credential.additionalRedactionValues }
      : {}),
  };
}

export const CODEX_PROVIDER_BINDING_ADAPTER_V1 = Object.freeze({
  v: 1,
  adapterVersion: CODEX_PROVIDER_BINDING_ADAPTER_VERSION_V1,
  prepare: prepareCodexProviderBindingV1,
  materialize: materializeCodexProviderBindingV1,
} satisfies AgentProviderBindingAdapter);

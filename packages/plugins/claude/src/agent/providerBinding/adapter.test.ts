import { describe, expect, it } from 'vitest';
import {
  AgentProviderBindingMaterializationV1Schema,
  ProviderConnectionIdSchema,
  resolveProviderBindingCompatibilityWithFingerprintV1,
} from '@happier-dev/protocol';
import type {
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from './adapter.js';

const connectionId = ProviderConnectionIdSchema.parse('pc_anthropic_gateway');

const bearerTransport = {
  id: 'anthropic-runtime-bearer',
  protocols: ['anthropic'],
  uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
} as const;

const apiKeyTransport = {
  id: 'anthropic-runtime-x-api-key',
  protocols: ['anthropic'],
  uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
} as const;

function prepareInput(): AgentProviderBindingPrepareInput {
  return {
    v: 1,
    agentTargetKey: 'backend:claude:built_in',
    connectionId,
  };
}

function materializeInput(
  overrides: Partial<AgentProviderBindingMaterializeInput> = {},
): AgentProviderBindingMaterializeInput {
  return {
    v: 1,
    binding: {
      v: 1,
      agentTargetKey: 'backend:claude:built_in',
      selection: {
        connectionId,
        model: {
          id: 'gateway-sonnet',
          name: 'Gateway Sonnet',
        },
      },
      contributionKey: 'happier.provider.fixture/anthropic-gateway',
      endpoint: {
        endpointTemplateId: 'anthropic-messages',
        normalizedUrl: 'https://gateway.example.test/anthropic',
        protocol: 'anthropic',
        publicHeaders: {},
      },
      runtimeCredentialTransport: null,
      compatibilityFingerprint: 'pcf1:claude-fixture',
    },
    prepared: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput()),
    credential: { kind: 'none' },
    ...overrides,
  };
}

function applyOverlay(
  inherited: Readonly<Record<string, string>>,
  rows: readonly Readonly<{ name: string; value: string | null }>[],
): Record<string, string> {
  const result = { ...inherited };
  for (const row of rows) {
    if (row.value === null) delete result[row.name];
    else result[row.name] = row.value;
  }
  return result;
}

describe('Claude provider-binding adapter V1', () => {
  it('declares static Anthropic support that exactly agrees with the executable adapter', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;

    expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion).toBe(2);
    expect(support).toEqual({
      acceptsProtocols: ['anthropic'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [
          {
            protocol: 'anthropic',
            destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
          },
          {
            protocol: 'anthropic',
            destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] },
          },
        ],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['claude-subscription', 'anthropic'],
        ownedEnvKeys: [
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
        ],
      },
      materialization: 'spawnEnv',
      applyPolicy: 'live',
      supportsFreeformModelIds: true,
    });
    expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput())).toEqual({
      v: 1,
      materialization: support?.materialization,
    });
  });

  it('keeps an unproven Anthropic gateway binding experimental until lifecycle evidence exists', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
    const resolution = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'backend:claude:built_in',
      adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      agent: support,
      endpoints: [{
        id: 'anthropic-messages',
        protocol: 'anthropic',
        baseUrl: 'https://gateway.example.test/anthropic',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      model: { id: 'gateway-sonnet', name: 'Gateway Sonnet' },
    });

    expect(resolution.result).toMatchObject({
      status: 'experimental',
      selectedProtocol: 'anthropic',
      confirmationScope: { kind: 'model', modelId: 'gateway-sonnet' },
    });
  });

  it('emits every owned key exactly once and clears all ambient native auth for no-auth bindings', async () => {
    const ambient = {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_CUSTOM_HEADERS: 'x-ambient: inherited',
      ANTHROPIC_API_KEY: 'ambient-api-key',
      ANTHROPIC_AUTH_TOKEN: 'ambient-auth-token',
      ANTHROPIC_OAUTH_TOKEN: 'ambient-oauth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-claude-oauth',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh',
      CLAUDE_CODE_OAUTH_SCOPES: 'ambient-scopes',
      CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      UNRELATED_SESSION_VALUE: 'preserved',
    };
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());
    expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);
    expect(output.kind).toBe('spawnEnv');
    expect(output.env).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test/anthropic', source: 'provider' },
      { name: 'ANTHROPIC_CUSTOM_HEADERS', value: null, source: 'provider' },
      { name: 'ANTHROPIC_API_KEY', value: null, source: 'provider' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: null, source: 'provider' },
      { name: 'ANTHROPIC_OAUTH_TOKEN', value: null, source: 'provider' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: null, source: 'provider' },
      { name: 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', value: null, source: 'provider' },
      { name: 'CLAUDE_CODE_OAUTH_SCOPES', value: null, source: 'provider' },
      { name: 'CLAUDE_CODE_SETUP_TOKEN', value: null, source: 'provider' },
      { name: 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', value: null, source: 'provider' },
    ]);
    expect(applyOverlay(ambient, output.env)).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      UNRELATED_SESSION_VALUE: 'preserved',
    });
    // The adapter is declarative: a following native spawn still inherits the untouched source env.
    expect(ambient.ANTHROPIC_API_KEY).toBe('ambient-api-key');
    expect(ambient.CLAUDE_CODE_OAUTH_TOKEN).toBe('ambient-claude-oauth');
  });

  it('renders validated public headers deterministically and isolates them from ambient/native launches', async () => {
    const ambient = {
      ANTHROPIC_CUSTOM_HEADERS: 'x-ambient: inherited',
      UNRELATED_SESSION_VALUE: 'preserved',
    };
    const base = materializeInput();
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: {
          ...base.binding.endpoint,
          publicHeaders: {
            'x-z-last': 'z-value',
            'x-a-first': 'a-value',
          },
        },
      },
    }));

    expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);
    expect(output.env.find((row) => row.name === 'ANTHROPIC_CUSTOM_HEADERS')).toEqual({
      name: 'ANTHROPIC_CUSTOM_HEADERS',
      value: 'x-a-first: a-value\nx-z-last: z-value',
      source: 'provider',
    });
    expect(applyOverlay(ambient, output.env)).toMatchObject({
      ANTHROPIC_CUSTOM_HEADERS: 'x-a-first: a-value\nx-z-last: z-value',
      UNRELATED_SESSION_VALUE: 'preserved',
    });
    expect(output.env.find((row) => row.name === 'ANTHROPIC_CUSTOM_HEADERS')?.value).not.toContain('\r');
    expect(ambient.ANTHROPIC_CUSTOM_HEADERS).toBe('x-ambient: inherited');
  });

  it.each([
    ['Authorization bearer', bearerTransport, 'ANTHROPIC_AUTH_TOKEN'],
    ['x-api-key raw', apiKeyTransport, 'ANTHROPIC_API_KEY'],
  ] as const)('maps %s to only its verified Claude credential variable', async (_label, transport, envKey) => {
    const base = materializeInput();
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: { ...base.binding, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'selected-secret' },
    }));
    expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);

    expect(output.env.find((row) => row.name === envKey)?.value).toBe('selected-secret');
    expect(output.env.filter((row) => row.value !== null).map((row) => row.name)).toEqual([
      'ANTHROPIC_BASE_URL',
      envKey,
    ]);
  });

  it('rejects unsupported protocols, transports, and mismatched preparation', async () => {
    const base = materializeInput();
    const unsupportedTransport = {
      id: 'unsupported',
      protocols: ['anthropic'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'raw' },
    } as const;

    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        runtimeCredentialTransport: unsupportedTransport,
      },
      credential: { kind: 'apiKey', transport: unsupportedTransport, value: 'secret' },
    }))).rejects.toThrow(/does not support/u);
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: { ...base.binding.endpoint, protocol: 'openai-chat' },
      },
    }))).rejects.toThrow(/Anthropic protocol/u);
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      prepared: { v: 1, materialization: 'configFile', adapterBindingKey: 'wrong' },
    }))).rejects.toThrow(/preparation/u);
  });
});

import { describe, expect, it } from 'vitest';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type {
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { ANTHROPIC_EFFORT_LEVELS } from '../../provider/catalog.js';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from './adapter.js';
import { selectProviderRuntimeCredentialTransportV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../vercel-ai-gateway/src/provider/contribution.js';
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../cloudflare-ai-gateway/src/provider/contribution.js';

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

function managedMaterializeInput(
  roleModels: NonNullable<AgentProviderBindingMaterializeInput['binding']['roleModels']>,
): AgentProviderBindingMaterializeInput {
  const input = materializeInput();
  return {
    ...input,
    binding: { ...input.binding, roleModels },
    prepared: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare({
      ...prepareInput(),
      model: input.binding.selection.model,
      roleModels,
    }),
  };
}

describe('Claude provider-binding adapter V1', () => {
  it('maps declared role-model selections to the native helper variables', async () => {
    const input = materializeInput();
    const roleModels = { fast: 'quick-model', default: 'balanced-model', strongest: 'deep-model' };
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({
      ...input,
      binding: { ...input.binding, roleModels },
      prepared: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare({
        ...prepareInput(), model: input.binding.selection.model, roleModels,
      }),
    });
    expect(applyOverlay({}, output.env)).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'quick-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'balanced-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deep-model',
    });
  });

  it('refuses a custom-only materialization without native startup authentication', async () => {
    const transport = { ...apiKeyTransport, destination: { kind: 'httpHeader' as const, name: 'x-private-gateway', format: 'raw' as const } };
    const base = materializeInput();
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...base,
      binding: { ...base.binding, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'gateway-key' },
    })).rejects.toThrow();
  });

  it.each([
    ['Vercel', VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION],
    ['Cloudflare', CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION],
  ] as const)('selects and materializes the real %s contribution through the same owner', async (_name, contribution) => {
    const selected = selectProviderRuntimeCredentialTransportV1({ transports: contribution.credential.transports,
      protocol: 'anthropic', agent: PLUGIN_MANIFEST.contributes.agents[0].providerRequirements });
    expect(selected).not.toBeNull();
    if (!selected) throw new Error('Expected an admitted Anthropic transport');
    const base = materializeInput();
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...base,
      binding: { ...base.binding, runtimeCredentialTransport: selected },
      credential: { kind: 'apiKey', transport: selected, value: 'gateway-key',
        additionalCredentials: (selected.additionalCredentials ?? []).map(row => ({ slotId: row.slotId, value: 'upstream-key' })) },
    });
    const env = Object.fromEntries(output.env.map(row => [row.name, row.value]));
    if (selected.destination.name === 'authorization') {
      expect(env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'gateway-key', ANTHROPIC_API_KEY: null });
    } else {
      expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'upstream-key', ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_CUSTOM_HEADERS: `${selected.destination.name}: Bearer gateway-key` });
    }
  });

  it.each(['raw', 'bearer'] as const)('selects and materializes a generic %s custom credential header', async (format) => {
    const transport = { ...apiKeyTransport, id: 'custom-header',
      destination: { kind: 'httpHeader' as const, name: 'x-private-gateway', format },
      additionalCredentials: [{ slotId: 'upstreamKey', destination: apiKeyTransport.destination }] };
    const support = PLUGIN_MANIFEST.contributes.agents[0].providerRequirements;
    const selected = selectProviderRuntimeCredentialTransportV1({ transports: [transport], agent: support, protocol: 'anthropic' });
    expect(selected).toEqual(transport);
    const input = materializeInput();
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input,
      binding: { ...input.binding, runtimeCredentialTransport: selected },
      credential: { kind: 'apiKey', transport, value: 'private-gateway-value',
        additionalCredentials: [{ slotId: 'upstreamKey', value: 'upstream-key' }] },
    });
    expect(Object.fromEntries(output.env.map(row => [row.name, row.value]))).toMatchObject({
      ANTHROPIC_API_KEY: 'upstream-key', ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_CUSTOM_HEADERS: `x-private-gateway: ${format === 'bearer' ? 'Bearer ' : ''}private-gateway-value`,
    });
    expect(output.additionalRedactionValues).toContain('private-gateway-value');
  });

  it('materializes independent upstream and gateway keys and refuses missing or colliding companions', async () => {
    const transport = { ...apiKeyTransport, id: 'two-keys',
      destination: { kind: 'httpHeader' as const, name: 'x-gateway-token', format: 'bearer' as const },
      additionalCredentials: [{ slotId: 'upstreamKey', destination: apiKeyTransport.destination }] };
    const selected = selectProviderRuntimeCredentialTransportV1({ transports: [transport],
      agent: PLUGIN_MANIFEST.contributes.agents[0].providerRequirements, protocol: 'anthropic' });
    expect(selected).toEqual(transport);
    const base = materializeInput();
    const input = { ...base, binding: { ...base.binding, runtimeCredentialTransport: selected },
      credential: { kind: 'apiKey' as const, transport, value: 'gateway-secret',
        additionalCredentials: [{ slotId: 'upstreamKey', value: 'upstream-secret' }] } };
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(input);
    expect(Object.fromEntries(output.env.map(row => [row.name, row.value]))).toMatchObject({
      ANTHROPIC_API_KEY: 'upstream-secret', ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_CUSTOM_HEADERS: 'x-gateway-token: Bearer gateway-secret',
    });
    expect(output.additionalRedactionValues).toEqual(expect.arrayContaining(['gateway-secret', 'Bearer gateway-secret', 'upstream-secret']));
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input,
      credential: { kind: 'apiKey', transport, value: 'gateway-secret' },
    })).rejects.toThrow();
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input,
      binding: { ...input.binding, endpoint: { ...input.binding.endpoint, publicHeaders: { 'X-Gateway-Token': 'spoof' } } },
    })).rejects.toThrow();
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input,
      credential: { ...input.credential, additionalCredentials: [{ slotId: 'upstreamKey', value: 'bad\r\nInjected: value' }] },
    })).rejects.toThrow();
    await expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input,
      credential: { ...input.credential, value: 'bad\nprimary' },
    })).rejects.toThrow();
  });

  it('preserves native alias environment on external Provider bindings', async () => {
    const ambient = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-native-pin' };
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());
    expect(applyOverlay(ambient, output.env).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('user-native-pin');
  });

  it('pins managed gateway helper aliases to the selected session model when unset', async () => {
    const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize(managedMaterializeInput({}));

    expect(Object.fromEntries(output.env.filter((row) => row.name.startsWith('ANTHROPIC_DEFAULT_'))
      .map((row) => [row.name, row.value]))).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gateway-sonnet',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway-sonnet',
    });
  });

  it('applies explicit helper pins without adding a subagent override', async () => {
    const savedPins = { fast: 'gateway-fast', strongest: 'gateway-strongest' };
    for (const modelId of ['gateway-sonnet', 'gateway-second']) {
      const input = managedMaterializeInput(savedPins);
      const model = { id: modelId, name: modelId };
      const output = await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({
        ...input,
        binding: { ...input.binding, selection: { ...input.binding.selection, model } },
        prepared: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare({ ...prepareInput(), model, roleModels: savedPins }),
      });
      expect(Object.fromEntries(output.env.filter((row) => row.name.startsWith('ANTHROPIC_DEFAULT_'))
        .map((row) => [row.name, row.value]))).toEqual({
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gateway-fast',
        ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway-strongest',
      });
      expect(output.env.some((row) => row.name.includes('SUBAGENT'))).toBe(false);
    }
  });

  it('changes the existing binding key only when resolved helper pins change', () => {
    const prepare = (modelId: string, roleModels: NonNullable<AgentProviderBindingMaterializeInput['binding']['roleModels']>) => (
      CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare({
        ...prepareInput(), model: { id: modelId, name: modelId }, roleModels,
      })
    );
    expect(prepare('model-a', {}).adapterBindingKey).toBeDefined();
    expect(prepare('model-a', {}).adapterBindingKey).not.toEqual(prepare('model-b', {}).adapterBindingKey);
    const explicit = { fast: 'fast', default: 'default', strongest: 'strongest' };
    expect(prepare('model-a', explicit).adapterBindingKey).toEqual(prepare('model-b', explicit).adapterBindingKey);
  });

  it('declares static Anthropic support that exactly agrees with the executable adapter', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;

    expect(CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion).toBe(4);
    expect(support).toEqual({
      acceptsProtocols: ['anthropic'],
      modelRoles: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.modelRoles,
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        supportsAdditionalCredentials: true,
        requiredApiKeyTransports: [
          { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
          { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } },
        ],
        apiKeyTransports: [
          {
            protocol: 'anthropic',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
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
        optionalOwnedEnvKeys: [
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
        ],
      },
      materialization: 'spawnEnv',
      applyPolicy: 'live',
      supportsFreeformModelIds: true,
      supportsReasoningEffort: true,
      reasoningEffortValues: ANTHROPIC_EFFORT_LEVELS,
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
      destination: { kind: 'httpHeader', name: 'authorization', format: { template: 'Token {secret}' } },
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

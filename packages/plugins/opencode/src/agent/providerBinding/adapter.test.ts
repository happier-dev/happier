import { describe, expect, it } from 'vitest';
import {
  AgentProviderBindingMaterializationV1Schema,
  ProviderConnectionIdSchema,
  resolveProviderBindingCompatibilityWithFingerprintV1,
} from '@happier-dev/protocol';
import type {
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from './adapter.js';

const connectionId = ProviderConnectionIdSchema.parse('pc_openrouter_work');

const bearerTransport = {
  id: 'runtime-bearer',
  protocols: ['openai-responses'],
  uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
} as const;

function prepareInput(
  overrides: Partial<AgentProviderBindingPrepareInput> = {},
): AgentProviderBindingPrepareInput {
  return {
    v: 1,
    agentTargetKey: 'backend:opencode:built_in',
    connectionId,
    ...overrides,
  };
}

function materializeInput(
  overrides: Partial<AgentProviderBindingMaterializeInput> = {},
): AgentProviderBindingMaterializeInput {
  return {
    v: 1,
    binding: {
      v: 1,
      agentTargetKey: 'backend:opencode:built_in',
      selection: { connectionId, model: { id: 'vendor/model', name: 'Vendor model' } },
      contributionKey: 'happier.provider.openrouter/openrouter',
      endpoint: {
        endpointTemplateId: 'openrouter-openai-responses',
        normalizedUrl: 'https://openrouter.ai/api/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: null,
      compatibilityFingerprint: 'pcf1:opencode-fixture',
    },
    prepared: OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput()),
    credential: { kind: 'none' },
    ...overrides,
  };
}

function fileConfig(output: Awaited<ReturnType<typeof OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize>>) {
  if (output.kind !== 'configFile') throw new Error('Expected OpenCode config-file materialization');
  return JSON.parse(output.files[0]!.utf8) as Readonly<Record<string, unknown>>;
}

describe('OpenCode provider-binding adapter V1', () => {
  it('declares exact Chat/Responses support that agrees with the executable adapter', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;

    expect(support).toEqual({
      acceptsProtocols: ['openai-responses', 'openai-chat'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [
          {
            protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
          },
          {
            protocol: 'openai-chat',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
          },
        ],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
        ownedEnvKeys: [
          'HAPPIER_OPENCODE_PROVIDER_API_KEY',
          'OPENCODE_AUTH_CONTENT',
          'OPENCODE_CONFIG_CONTENT',
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
        ],
      },
      materialization: 'configFile',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: true,
    });
    expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput())).toEqual({
      v: 1,
      materialization: support?.materialization,
      adapterBindingKey: expect.stringMatching(/^happier_[a-f0-9]{32}$/u),
    });
  });

  it('materializes the exact static owned environment set so native credentials cannot bypass the selected Provider', async () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());

    expect(output.env.map((entry) => entry.name).sort()).toEqual(
      [...support.authIsolation.ownedEnvKeys].sort(),
    );
  });

  it('keeps an unproven OpenCode provider binding experimental until lifecycle evidence exists', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
    const resolution = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'backend:opencode:built_in',
      adapterVersion: OPENCODE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      agent: support,
      endpoints: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://gateway.example.test/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      model: { id: 'gateway-model', name: 'Gateway model' },
    });

    expect(resolution.result).toMatchObject({
      status: 'experimental',
      selectedProtocol: 'openai-responses',
      confirmationScope: { kind: 'model', modelId: 'gateway-model' },
    });
  });

  it.each([
    ['openai-responses', '@ai-sdk/openai', { apiKey: 'happier-no-auth' }],
    ['openai-chat', '@ai-sdk/openai-compatible', {}],
  ] as const)('owns the verified %s driver mapping and a session-only selected-model config', async (
    protocol,
    npm,
    noAuthOptions,
  ) => {
    const base = materializeInput();
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: { ...base.binding.endpoint, protocol },
      },
    }));
    expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);
    const bindingKey = materializeInput().prepared.adapterBindingKey!;

    expect(output).toMatchObject({
      v: 1,
      kind: 'configFile',
      env: [
        { name: 'HAPPIER_OPENCODE_PROVIDER_API_KEY', value: null, source: 'provider' },
        { name: 'OPENCODE_AUTH_CONTENT', value: null, source: 'provider' },
        { name: 'OPENCODE_CONFIG_CONTENT', value: null, source: 'provider' },
        { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
        { name: 'ANTHROPIC_API_KEY', value: null, source: 'provider' },
      ],
      files: [{ relativePath: 'opencode/opencode.json' }],
    });
    expect(fileConfig(output)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      enabled_providers: [bindingKey],
      model: `${bindingKey}/vendor/model`,
      provider: {
        [bindingKey]: {
          npm,
          name: 'Happier provider',
          options: { baseURL: 'https://openrouter.ai/api/v1', ...noAuthOptions },
          models: { 'vendor/model': { name: 'Vendor model' } },
        },
      },
    });
  });

  it('keeps the raw key in child-only env and references it from config without persisting it', async () => {
    const base = materializeInput();
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: {
          ...base.binding.endpoint,
          publicHeaders: { 'x-app-title': 'Happier' },
        },
        runtimeCredentialTransport: bearerTransport,
      },
      credential: { kind: 'apiKey', transport: bearerTransport, value: 'selected-secret' },
    }));
    expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);
    const configText = output.kind === 'configFile' ? output.files[0]!.utf8 : '';
    const config = fileConfig(output);
    const bindingKey = materializeInput().prepared.adapterBindingKey!;

    expect(output.env).toEqual([
      { name: 'HAPPIER_OPENCODE_PROVIDER_API_KEY', value: 'selected-secret', source: 'provider' },
      { name: 'OPENCODE_AUTH_CONTENT', value: null, source: 'provider' },
      { name: 'OPENCODE_CONFIG_CONTENT', value: null, source: 'provider' },
      { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
      { name: 'ANTHROPIC_API_KEY', value: null, source: 'provider' },
    ]);
    expect(configText).not.toContain('selected-secret');
    expect(config).toMatchObject({
      provider: {
        [bindingKey]: {
          options: {
            apiKey: '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}',
            headers: { 'x-app-title': 'Happier' },
          },
        },
      },
    });
  });

  it('maps non-standard raw headers through an env reference and rejects public-header collisions', async () => {
    const rawHeaderTransport = {
      id: 'runtime-x-api-key',
      protocols: ['openai-chat'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
    } as const;
    const base = materializeInput();
    const chatBinding = {
      ...base.binding,
      endpoint: { ...base.binding.endpoint, protocol: 'openai-chat' as const },
      runtimeCredentialTransport: rawHeaderTransport,
    };
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: chatBinding,
      credential: { kind: 'apiKey', transport: rawHeaderTransport, value: 'selected-secret' },
    }));
    const bindingKey = materializeInput().prepared.adapterBindingKey!;
    expect(fileConfig(output)).toMatchObject({
      provider: {
        [bindingKey]: {
          options: { headers: { 'x-api-key': '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}' } },
        },
      },
    });

    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...chatBinding,
        endpoint: {
          ...chatBinding.endpoint,
          publicHeaders: { 'X-API-KEY': 'public-value' },
        },
      },
      credential: { kind: 'apiKey', transport: rawHeaderTransport, value: 'selected-secret' },
    }))).rejects.toThrow(/competes/u);
  });

  it('is deterministic, rejects unsupported protocols/transports, and never mutates ambient auth', async () => {
    const first = OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput());
    const repeated = OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput());
    const secondConnection = OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({
      connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_personal'),
    }));
    expect(first).toEqual(repeated);
    expect(secondConnection.adapterBindingKey).not.toBe(first.adapterBindingKey);

    const ambient = {
      OPENCODE_AUTH_CONTENT: '{"native":"secret"}',
      OPENCODE_CONFIG_CONTENT: '{"provider":{"native":{}}}',
    };
    await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());
    expect(ambient).toEqual({
      OPENCODE_AUTH_CONTENT: '{"native":"secret"}',
      OPENCODE_CONFIG_CONTENT: '{"provider":{"native":{}}}',
    });

    const base = materializeInput();
    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: { ...base.binding.endpoint, protocol: 'anthropic' },
      },
    }))).rejects.toThrow(/does not support/u);
    const queryTransport = {
      id: 'query',
      protocols: ['openai-responses'],
      uses: ['runtime'],
      destination: { kind: 'queryParam', name: 'api_key', format: 'raw' },
    } as const;
    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: { ...base.binding, runtimeCredentialTransport: queryTransport },
      credential: { kind: 'apiKey', transport: queryTransport, value: 'secret' },
    }))).rejects.toThrow(/does not support/u);
  });
});

import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type {
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  CODEX_PROVIDER_BINDING_ADAPTER_V1,
  CODEX_PROVIDER_BINDING_ENGINE_CONFIG_FIELDS_V1,
} from './adapter.js';

const connectionId = ProviderConnectionIdSchema.parse('pc_openrouter_personal');

function prepareInput(
  overrides: Partial<AgentProviderBindingPrepareInput> = {},
): AgentProviderBindingPrepareInput {
  return {
    v: 1,
    agentTargetKey: 'backend:codex:built_in',
    connectionId,
    ...overrides,
  };
}

const bearerTransport = {
  id: 'runtime-bearer',
  protocols: ['openai-responses'],
  uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
} as const;

function materializeInput(
  overrides: Partial<AgentProviderBindingMaterializeInput> = {},
): AgentProviderBindingMaterializeInput {
  const prepared = CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput());
  return {
    v: 1,
    binding: {
      v: 1,
      agentTargetKey: 'backend:codex:built_in',
      selection: {
        connectionId,
        model: {
          id: 'vendor/model',
          name: 'Vendor Model',
          capabilities: {},
        },
      },
      contributionKey: 'happier.provider.openrouter/openrouter',
      endpoint: {
        endpointTemplateId: 'openrouter-openai-responses',
        normalizedUrl: 'https://openrouter.ai/api/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: null,
      compatibilityFingerprint: 'pcf1:fixture',
    },
    prepared,
    credential: { kind: 'none' },
    ...overrides,
  };
}

describe('Codex provider-binding adapter V1', () => {
  it('declares exact Responses support that agrees with the executable adapter', () => {
    const requirements = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;

    expect(requirements).toEqual({
      acceptsProtocols: ['openai-responses'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['openai-codex', 'openai'],
        ownedEnvKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
      },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: true,
    });
    expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput())).toMatchObject({
      materialization: requirements?.materialization,
    });
  });

  it('derives a stable collision-resistant custom key from only the allowed prepare inputs', () => {
    const first = CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput());
    const repeated = CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput());
    const otherConnection = CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({
      connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
    }));

    expect(first).toEqual(repeated);
    expect(first).toEqual({
      v: 1,
      materialization: 'engineConfig',
      adapterBindingKey: expect.stringMatching(/^happier_[a-f0-9]{32}$/u),
    });
    expect(otherConnection.adapterBindingKey).not.toBe(first.adapterBindingKey);
  });

  it('uses reserved Codex ids only for exact audited built-in candidates', () => {
    for (const contributionKey of [
      'happier.provider.ollama/ollama',
      'happier.provider.ollama/ollama',
    ]) {
      expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({
        reservedBindingCandidate: {
          contributionKey,
          endpointTemplateId: 'ollama-openai-responses',
          protocol: 'openai-responses',
          normalizedUrl: 'http://localhost:11434/v1',
        },
      })).adapterBindingKey).toBe('ollama');
    }
    for (const contributionKey of [
      'happier.provider.lmstudio/lmstudio',
      'happier.provider.lmstudio/lmstudio',
    ]) {
      expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({
        reservedBindingCandidate: {
          contributionKey,
          endpointTemplateId: 'lmstudio-openai-responses',
          protocol: 'openai-responses',
          normalizedUrl: 'http://localhost:1234/v1',
        },
      })).adapterBindingKey).toBe('lmstudio');
    }

    for (const reservedBindingCandidate of [
      {
        contributionKey: 'user.custom/ollama',
        endpointTemplateId: 'ollama-openai-responses',
        protocol: 'openai-responses' as const,
        normalizedUrl: 'http://localhost:11434/v1',
      },
      {
        contributionKey: 'happier.provider.ollama/ollama',
        endpointTemplateId: 'ollama-openai-responses',
        protocol: 'openai-responses' as const,
        normalizedUrl: 'http://localhost:11435/v1',
      },
    ]) {
      expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({ reservedBindingCandidate })).adapterBindingKey)
        .toMatch(/^happier_[a-f0-9]{32}$/u);
    }
  });

  it('emits the fixed safe Responses config and explicit ambient-auth unsets for no-auth providers', async () => {
    const output = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());
    const bindingKey = materializeInput().prepared.adapterBindingKey;

    expect(output).toEqual({
      v: 1,
      kind: 'engineConfig',
      env: [
        { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: null, source: 'provider' },
        { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
        { name: 'CODEX_API_KEY', value: null, source: 'provider' },
      ],
      engineConfig: {
        v: 1,
        modelProvider: bindingKey,
        config: {
          [`model_providers.${bindingKey}`]: {
            name: 'Happier provider',
            base_url: 'https://openrouter.ai/api/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
    });
  });

  it('disables Codex reasoning only for explicit non-reasoning capability evidence', async () => {
    const base = materializeInput();
    const output = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        selection: {
          ...base.binding.selection,
          model: {
            ...base.binding.selection.model,
            capabilities: {
              reasoningControls: 'unsupported',
            },
          },
        },
      },
    }));

    expect(output).toMatchObject({
      kind: 'engineConfig',
      engineConfig: {
        config: { model_reasoning_effort: 'none' },
      },
    });

    const supported = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        selection: {
          ...base.binding.selection,
          model: {
            ...base.binding.selection.model,
            capabilities: {
              reasoningControls: 'supported',
            },
          },
        },
      },
    }));
    expect(supported).not.toMatchObject({
      engineConfig: {
        config: { model_reasoning_effort: expect.anything() },
      },
    });
  });

  it('maps Authorization bearer auth to env_key without embedding the secret in config', async () => {
    const input = materializeInput({
      binding: {
        ...materializeInput().binding,
        endpoint: {
          ...materializeInput().binding.endpoint,
          publicHeaders: { 'x-happier-title': 'Happier' },
        },
        runtimeCredentialTransport: bearerTransport,
      },
      credential: { kind: 'apiKey', transport: bearerTransport, value: 'secret-value' },
    });

    const output = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(input);
    const config = output.kind === 'engineConfig'
      ? output.engineConfig.config as Record<string, Record<string, unknown>>
      : {};
    const provider = config[`model_providers.${input.prepared.adapterBindingKey}`];
    expect(output.env).toEqual([
      { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'secret-value', source: 'provider' },
      { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
      { name: 'CODEX_API_KEY', value: null, source: 'provider' },
    ]);
    expect(provider).toEqual({
      name: 'Happier provider',
      base_url: 'https://openrouter.ai/api/v1',
      wire_api: 'responses',
      env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY',
      http_headers: { 'x-happier-title': 'Happier' },
      requires_openai_auth: false,
      supports_websockets: false,
    });
    expect(JSON.stringify(output.engineConfig)).not.toContain('secret-value');
  });

  it('maps raw and bearer custom headers through env_http_headers with rendered-value redaction', async () => {
    for (const [format, expectedValue, expectedRedactions] of [
      ['raw', 'secret-value', undefined],
      ['bearer', 'Bearer secret-value', ['Bearer secret-value']],
    ] as const) {
      const transport = {
        id: `runtime-${format}`,
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format },
      } as const;
      const base = materializeInput();
      const input = materializeInput({
        binding: { ...base.binding, runtimeCredentialTransport: transport },
        credential: { kind: 'apiKey', transport, value: 'secret-value' },
      });
      const output = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(input);
      expect(output.env[0]).toEqual({
        name: 'HAPPIER_CODEX_PROVIDER_API_KEY',
        value: expectedValue,
        source: 'provider',
      });
      expect(output.additionalRedactionValues).toEqual(expectedRedactions);
      expect(output.kind === 'engineConfig' && output.engineConfig.config).toEqual({
        [`model_providers.${input.prepared.adapterBindingKey}`]: {
          name: 'Happier provider',
          base_url: 'https://openrouter.ai/api/v1',
          wire_api: 'responses',
          env_http_headers: { 'x-api-key': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
          requires_openai_auth: false,
          supports_websockets: false,
        },
      });
    }
  });

  it('rejects a public header that would compete with the credential destination', async () => {
    const transport = {
      id: 'runtime-custom-header',
      protocols: ['openai-responses'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-provider-auth', format: 'raw' },
    } as const;
    const base = materializeInput();
    await expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: {
          ...base.binding.endpoint,
          publicHeaders: { 'x-provider-auth': 'public-value' },
        },
        runtimeCredentialTransport: transport,
      },
      credential: { kind: 'apiKey', transport, value: 'secret-value' },
    }))).rejects.toThrow('competes with the credential destination');
  });

  it('does not override reserved built-ins and rejects credentials they cannot represent', async () => {
    const prepared = CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput({
      reservedBindingCandidate: {
        contributionKey: 'happier.provider.ollama/ollama',
        endpointTemplateId: 'ollama-openai-responses',
        protocol: 'openai-responses',
        normalizedUrl: 'http://localhost:11434/v1',
      },
    }));
    const noAuth = materializeInput({
      prepared,
      binding: {
        ...materializeInput().binding,
        contributionKey: 'happier.provider.ollama/ollama',
        endpoint: {
          endpointTemplateId: 'ollama-openai-responses',
          normalizedUrl: 'http://localhost:11434/v1',
          protocol: 'openai-responses',
          publicHeaders: {},
        },
      },
    });
    await expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(noAuth)).resolves.toMatchObject({
      kind: 'engineConfig',
      engineConfig: { v: 1, modelProvider: 'ollama', config: {} },
    });
    await expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize({
      ...noAuth,
      binding: { ...noAuth.binding, runtimeCredentialTransport: bearerTransport },
      credential: { kind: 'apiKey', transport: bearerTransport, value: 'secret' },
    })).rejects.toThrow(/reserved Codex provider/u);
  });

  it('rejects mismatched or unsupported transports instead of emitting fallback config', async () => {
    const invalidTransports = [
      { ...bearerTransport, protocols: ['openai-chat'] as const },
      { ...bearerTransport, uses: ['probe'] as const },
      {
        ...bearerTransport,
        destination: { kind: 'queryParam' as const, name: 'api_key', format: 'raw' as const },
      },
      {
        ...bearerTransport,
        destination: { kind: 'httpHeader' as const, name: 'authorization', format: { template: 'Key {secret}' } },
      },
    ];
    for (const transport of invalidTransports) {
      const base = materializeInput();
      await expect(CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
        binding: { ...base.binding, runtimeCredentialTransport: transport },
        credential: { kind: 'apiKey', transport, value: 'secret' },
      } as Partial<AgentProviderBindingMaterializeInput>))).rejects.toThrow();
    }
  });

  it('keeps caller-controlled OpenAI-auth and WebSocket fields unrepresentable', async () => {
    expect(CODEX_PROVIDER_BINDING_ENGINE_CONFIG_FIELDS_V1).toEqual([
      'name',
      'base_url',
      'wire_api',
      'env_key',
      'http_headers',
      'env_http_headers',
      'requires_openai_auth',
      'supports_websockets',
    ]);
    const output = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput());
    if (output.kind !== 'engineConfig') throw new Error('Expected Codex engine config');
    const provider = Object.values(output.engineConfig.config as Record<string, Record<string, unknown>>)[0] ?? {};
    for (const unsupported of [
      'experimental_bearer_token',
      'auth',
      'aws',
      'query_params',
      'request_max_retries',
      'stream_max_retries',
      'stream_idle_timeout_ms',
      'websocket_connect_timeout_ms',
    ]) {
      expect(provider).not.toHaveProperty(unsupported);
    }
  });
});

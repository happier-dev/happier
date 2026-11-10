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
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1, OPENCODE_PROVIDER_OWNED_ENV_KEYS } from './adapter.js';
import { OPEN_CODE_CONNECTED_ACCOUNT_SERVICE_IDS } from '../auth/services/purposes.js';

const connectionId = ProviderConnectionIdSchema.parse('pc_openrouter_work');

const bearerTransport = {
  id: 'runtime-bearer',
  protocols: ['openai-chat'],
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
        endpointTemplateId: 'openrouter-openai-chat',
        normalizedUrl: 'https://openrouter.ai/api/v1',
        protocol: 'openai-chat',
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
  it.each(['modelId', 'modelName', 'publicHeader', 'endpoint'] as const)(
    'refuses native substitutions in Provider %s data before the native loader can expand them', async field => {
      const input = materializeInput();
      const interpolation = '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}';
      const binding = {
        ...input.binding,
        selection: { ...input.binding.selection, model: {
          id: field === 'modelId' ? interpolation : input.binding.selection.model.id,
          name: field === 'modelName' ? '{file:private.txt}' : input.binding.selection.model.name,
        } },
        endpoint: { ...input.binding.endpoint,
          normalizedUrl: field === 'endpoint' ? `https://gateway.example.test/${interpolation}` : input.binding.endpoint.normalizedUrl,
          publicHeaders: field === 'publicHeader' ? { 'x-route': interpolation } : {},
        },
      };
      await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...input, binding })).rejects.toThrow(/substitution/u);
    },
  );

  it('materializes selected-model generation settings at the native consumed fields', async () => {
    const input = materializeInput();
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({
      ...input,
      binding: { ...input.binding, modelSettings: { temperature: 0, maxTokens: 2048 } },
    });
    const key = input.prepared.adapterBindingKey!;
    expect(fileConfig(output)).toMatchObject({
      agent: { build: { temperature: 0 }, plan: { temperature: 0 } },
      provider: { [key]: { models: { 'vendor/model': {
        name: 'Vendor model', temperature: true, limit: { context: 0, output: 2048 },
      } } } },
    });
  });

  it.each([0, -1])('refuses a retained maxTokens=%s that native generation cannot preserve', async maxTokens => {
    const input = materializeInput();
    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({
      ...input, binding: { ...input.binding, modelSettings: { maxTokens } },
    })).rejects.toThrow('non-positive maxTokens');
  });

  it('leaves native generation defaults intact for unset settings', async () => {
    const input = materializeInput();
    expect(fileConfig(await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({
      ...input, binding: { ...input.binding, modelSettings: { temperature: null, maxTokens: null } },
    }))).toEqual(fileConfig(await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(input)));
  });

  it('declares exact Chat/Responses support that agrees with the executable adapter', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;

    expect({ ...support, authIsolation: {
      ...support?.authIsolation,
      suppressConnectedServiceIds: [...(support?.authIsolation.suppressConnectedServiceIds ?? [])].sort(),
      ownedEnvKeys: [...(support?.authIsolation.ownedEnvKeys ?? [])].sort(),
    } }).toEqual({
      acceptsProtocols: ['openai-responses', 'openai-chat'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        noAuthProtocols: ['openai-chat'],
        apiKeyTransports: [
          {
            protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
          },
          {
            protocol: 'openai-chat',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
          },
        ],
      },
      authIsolation: {
        suppressConnectedServiceIds: [...OPEN_CODE_CONNECTED_ACCOUNT_SERVICE_IDS].sort(),
        ownedEnvKeys: [...OPENCODE_PROVIDER_OWNED_ENV_KEYS].sort(),
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
      credential: {
        kind: 'apiKey',
        required: true,
        transports: [{
          id: 'bearer',
          protocols: ['openai-responses'],
          uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      model: { id: 'gateway-model', name: 'Gateway model' },
    });

    expect(resolution.result).toMatchObject({
      status: 'experimental',
      selectedProtocol: 'openai-responses',
      confirmationScope: { kind: 'model', modelId: 'gateway-model' },
    });
  });

  const gatewayEndpoint = (protocol: 'openai-responses' | 'openai-chat') => ({
    id: protocol,
    protocol,
    baseUrl: 'https://gateway.example.test/v1',
    capabilities: {
      streaming: 'supported' as const,
      toolRoundTrips: 'unknown' as const,
      statefulResponses: 'unknown' as const,
      reasoningControls: 'unknown' as const,
    },
  });

  it('binds a credential-free Provider over Chat Completions rather than the Responses driver', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
    const resolution = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'backend:opencode:built_in',
      adapterVersion: OPENCODE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      agent: support,
      endpoints: [gatewayEndpoint('openai-responses'), gatewayEndpoint('openai-chat')],
      credential: undefined,
      model: { id: 'gateway-model', name: 'Gateway model' },
    });

    expect(resolution.result).toMatchObject({ selectedProtocol: 'openai-chat' });
  });

  it('refuses a credential-free Responses-only Provider before it can be selected', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
    const resolution = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'backend:opencode:built_in',
      adapterVersion: OPENCODE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      agent: support,
      endpoints: [gatewayEndpoint('openai-responses')],
      credential: undefined,
      model: { id: 'gateway-model', name: 'Gateway model' },
    });

    expect(resolution.result).toMatchObject({
      status: 'incompatible',
      reasons: ['no_auth_unsupported'],
    });
  });

  it('refuses a credential-free Responses binding instead of sending a placeholder bearer', async () => {
    const base = materializeInput();
    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize(materializeInput({
      binding: {
        ...base.binding,
        endpoint: { ...base.binding.endpoint, protocol: 'openai-responses' },
      },
    }))).rejects.toThrow(/without a credential/u);
  });

  it.each([
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

    expect({ ...output, env: [...output.env].sort((a, b) => a.name.localeCompare(b.name)) }).toMatchObject({
      v: 1,
      kind: 'configFile',
      env: OPENCODE_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: null, source: 'provider' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
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

    expect([...output.env].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      OPENCODE_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name,
        value: name === 'HAPPIER_OPENCODE_PROVIDER_API_KEY' ? 'selected-secret' : null, source: 'provider',
      })).sort((a, b) => a.name.localeCompare(b.name)),
    );
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

  it.each(['raw', 'bearer'] as const)('refuses a custom %s Responses auth header before the native driver adds unwanted Authorization', async format => {
    const base = materializeInput();
    const transport = { id: 'custom-header', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-generic-auth', format } } as const;
    const endpoint = { protocol: 'openai-responses', capabilities: {
      streaming: 'supported', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown',
    }, id: 'responses', baseUrl: base.binding.endpoint.normalizedUrl } as const;
    const resolved = resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey: base.binding.agentTargetKey,
      agent: PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!, adapterVersion: 1, endpoints: [endpoint],
      model: base.binding.selection.model, credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [transport] } });
    expect(resolved.result).toMatchObject({ status: 'incompatible', reasons: ['credential_transport_unavailable'] });
    await expect(OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({ ...base,
      binding: { ...base.binding, endpoint: { ...base.binding.endpoint, protocol: 'openai-responses' }, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'synthetic-key' } })).rejects.toThrow(/Responses.*Authorization/u);
  });

  it.each(['raw', 'bearer'] as const)('maps non-standard Chat %s headers through an env reference and rejects public-header collisions', async format => {
    const rawHeaderTransport = {
      id: 'runtime-x-api-key',
      protocols: ['openai-chat'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format },
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
          options: { headers: { 'x-api-key': `${format === 'bearer' ? 'Bearer ' : ''}{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}` } },
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

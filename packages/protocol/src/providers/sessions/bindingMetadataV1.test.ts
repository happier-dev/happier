import { describe, expect, it } from 'vitest';

import {
  AgentSessionProviderBindingV1Schema,
  ProviderRuntimeBindingBasisV1Schema,
  applySessionProviderBindingMetadataV1,
  readSessionProviderBindingMetadataV1,
  readSessionProviderBindingMetadataStateV1,
  SESSION_PROVIDER_BINDING_METADATA_KEY_V1,
} from './bindingMetadataV1.js';

const binding = {
  v: 1 as const,
  connectionId: 'pc_work',
  contributionKey: 'plugin.openrouter/openrouter',
  connectionRevision: 3,
  protocol: 'openai-responses' as const,
  materialization: 'engineConfig' as const,
  adapterBindingKey: 'openrouter',
  compatibilityFingerprint: 'compatibility-v1',
  bindingSecurityFingerprint: 'security-v1',
  displaySnapshot: {
    providerName: 'OpenRouter',
    connectionName: 'Work',
    connectionRole: 'named' as const,
    connectionDisplayNameMode: 'custom' as const,
  },
};

describe('session provider binding metadata', () => {
  it('strictly validates a bounded non-secret active runtime binding basis', () => {
    const runtimeBindingBasis = {
      v: 1,
      deployment: { kind: 'external' },
      agentTargetKey: 'backend:codex',
      connectionId: 'pc_work',
      contributionKey: 'plugin.openrouter/openrouter',
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'openai-responses',
        publicHeaders: { 'x-provider': 'openrouter' },
      },
      runtimeCredentialTransport: {
        id: 'runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: {
        v: 1,
        materialization: 'engineConfig',
        adapterBindingKey: 'openrouter',
      },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security-v1',
        grantFingerprint: 'grant-v1',
        selectedSecretBindingId: 'binding-v1',
        selectedSecretRecordFingerprint: 'record-v1',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader',
              names: ['authorization'],
              formats: ['bearer'],
            },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: ['OPENAI_API_KEY'],
        },
        materialization: 'engineConfig',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } as const;

    expect(
      ProviderRuntimeBindingBasisV1Schema.parse(runtimeBindingBasis),
    ).toEqual(runtimeBindingBasis);
    expect(ProviderRuntimeBindingBasisV1Schema.safeParse({
      ...runtimeBindingBasis,
      credential: 'secret',
    }).success).toBe(false);
  });

  it('carries the exact authorized model descriptor with the launch materialization', () => {
    const providerBinding = {
      connectionId: 'pc_work',
      model: {
        id: 'gpt-5',
        name: 'GPT-5',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      },
      materialization: {
        v: 1,
        kind: 'engineConfig',
        engineConfig: { provider: { baseUrl: 'http://127.0.0.1:4455/v1' } },
      },
    } as const;

    expect(AgentSessionProviderBindingV1Schema.parse(providerBinding)).toEqual(providerBinding);
    expect(AgentSessionProviderBindingV1Schema.safeParse({
      ...providerBinding,
      model: { id: 'different', name: '' },
    }).success).toBe(false);
  });

  it('owns one canonical metadata key and ignores malformed persisted values', () => {
    const metadata = applySessionProviderBindingMetadataV1({ path: '/tmp' }, binding);

    expect(metadata[SESSION_PROVIDER_BINDING_METADATA_KEY_V1]).toEqual(binding);
    expect(readSessionProviderBindingMetadataV1(metadata)).toEqual(binding);
    expect(readSessionProviderBindingMetadataV1({
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: { ...binding, bindingSecurityFingerprint: '' },
    })).toBeNull();
  });

  it('distinguishes absent, valid, and present-invalid persisted binding metadata', () => {
    expect(readSessionProviderBindingMetadataStateV1({ path: '/tmp' })).toEqual({ kind: 'absent' });
    expect(readSessionProviderBindingMetadataStateV1({
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: binding,
    })).toEqual({ kind: 'valid', binding });
    expect(readSessionProviderBindingMetadataStateV1({
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: { ...binding, bindingSecurityFingerprint: '' },
    })).toEqual({ kind: 'invalid' });
    expect(readSessionProviderBindingMetadataStateV1({
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: null,
    })).toEqual({ kind: 'invalid' });
  });

  it('removes the canonical binding key when a native restart clears the provider binding', () => {
    expect(applySessionProviderBindingMetadataV1({
      path: '/tmp',
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: binding,
    }, null)).toEqual({ path: '/tmp' });
  });
});

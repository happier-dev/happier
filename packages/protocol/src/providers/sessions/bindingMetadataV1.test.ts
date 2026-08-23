import { describe, expect, it } from 'vitest';

import {
  AgentSessionProviderBindingV1Schema,
  ProviderRuntimeBindingBasisV1Schema,
  applySessionProviderBindingMetadataV1,
  projectAgentSessionProviderBindingV1,
  readSessionProviderBindingMetadataV1,
  readSessionProviderBindingMetadataStateV1,
  SESSION_PROVIDER_BINDING_METADATA_KEY_V1,
  sessionProviderBindingMetadataMatchesRuntimeBasisV1,
} from './bindingMetadataV1.js';
import { createProviderBindingSecurityFingerprintV1 } from '../securityFingerprintsV1.js';

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

describe('session provider binding metadata', () => {
  it('strictly validates a bounded non-secret active runtime binding basis', () => {
    expect(
      ProviderRuntimeBindingBasisV1Schema.parse(runtimeBindingBasis),
    ).toEqual(runtimeBindingBasis);
    expect(ProviderRuntimeBindingBasisV1Schema.safeParse({
      ...runtimeBindingBasis,
      credential: 'secret',
    }).success).toBe(false);
  });

  it('rejects a model-specific binding fingerprint that does not match the runtime basis', () => {
    const model = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: { reasoningControls: 'supported' as const },
    };
    const bindingSecurityFingerprint =
      createProviderBindingSecurityFingerprintV1({
        agentTargetKey: runtimeBindingBasis.agentTargetKey,
        connectionId: runtimeBindingBasis.connectionId,
        modelId: model.id,
        modelCapabilities: model.capabilities,
        endpointTemplateId: runtimeBindingBasis.endpoint.endpointTemplateId,
        endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
        protocol: runtimeBindingBasis.endpoint.protocol,
        publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
        materialization: runtimeBindingBasis.prepared.materialization,
        adapterBindingKey: runtimeBindingBasis.prepared.adapterBindingKey,
        credentialDestination:
          runtimeBindingBasis.runtimeCredentialTransport.destination,
        compatibilityFingerprint: 'compatibility-v1',
        adapterVersion: runtimeBindingBasis.adapterVersion,
      });
    const coherentBinding = {
      ...binding,
      model,
      bindingSecurityFingerprint,
      runtimeBindingBasis,
    };

    expect(sessionProviderBindingMetadataMatchesRuntimeBasisV1({
      selection: {
        agentTargetKey: runtimeBindingBasis.agentTargetKey,
        providerConnectionId: runtimeBindingBasis.connectionId,
      },
      binding: coherentBinding,
    })).toBe(true);
    expect(sessionProviderBindingMetadataMatchesRuntimeBasisV1({
      selection: {
        agentTargetKey: runtimeBindingBasis.agentTargetKey,
        providerConnectionId: runtimeBindingBasis.connectionId,
      },
      binding: {
        ...coherentBinding,
        bindingSecurityFingerprint: createProviderBindingSecurityFingerprintV1({
          agentTargetKey: runtimeBindingBasis.agentTargetKey,
          connectionId: runtimeBindingBasis.connectionId,
          modelId: 'gpt-4',
          modelCapabilities: model.capabilities,
          endpointTemplateId: runtimeBindingBasis.endpoint.endpointTemplateId,
          endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
          protocol: runtimeBindingBasis.endpoint.protocol,
          publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
          materialization: runtimeBindingBasis.prepared.materialization,
          adapterBindingKey: runtimeBindingBasis.prepared.adapterBindingKey,
          credentialDestination:
            runtimeBindingBasis.runtimeCredentialTransport.destination,
          compatibilityFingerprint: 'compatibility-v1',
          adapterVersion: runtimeBindingBasis.adapterVersion,
        }),
      },
    })).toBe(false);
  });

  it('carries the exact authorized model descriptor with the launch materialization', () => {
    const model = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'supported',
      },
    } as const;
    const materialization = {
      v: 1,
      kind: 'engineConfig',
      engineConfig: { provider: { baseUrl: 'http://127.0.0.1:4455/v1' } },
    } as const;
    const providerBinding = projectAgentSessionProviderBindingV1({
      metadata: {
        ...binding,
        model,
        runtimeBindingBasis,
      },
      materialization,
    });

    expect(AgentSessionProviderBindingV1Schema.parse(providerBinding)).toEqual({
      connectionId: 'pc_work',
      model,
      upstream: {
        protocol: 'openai-responses',
        normalizedUrl: 'https://provider.example/v1',
        credential: 'apiKey',
      },
      materialization,
    });
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

import { describe, expect, it } from 'vitest';

import { compareSessionProviderBindingV1 } from './lifecycle.js';
import { SessionProviderBindingMetadataV1Schema } from './bindingMetadataV1.js';
import { createProviderBindingSecurityFingerprintV1 } from '../securityFingerprintsV1.js';

function binding(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    connectionId: 'pc_a', contributionKey: 'plugin/p', connectionRevision: 1,
    protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'p_pc_a',
    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
    displaySnapshot: {
      providerName: 'P', connectionName: 'P', connectionRole: 'default', connectionDisplayNameMode: 'automatic',
    },
    ...overrides,
  } as const;
}

describe('compareSessionProviderBindingV1', () => {
  it('rejects adapter binding keys that cannot be fingerprinted or rematerialized', () => {
    expect(SessionProviderBindingMetadataV1Schema.safeParse(binding({ adapterBindingKey: 'bad\nkey' })).success).toBe(false);
    expect(SessionProviderBindingMetadataV1Schema.safeParse(binding({ adapterBindingKey: 'bad/key' })).success).toBe(false);
    expect(SessionProviderBindingMetadataV1Schema.parse(binding()).adapterBindingKey).toBe('p_pc_a');
  });

  it('treats display and revision changes as benign when the security binding is unchanged', () => {
    expect(compareSessionProviderBindingV1(binding(), binding({
      connectionRevision: 2,
      displaySnapshot: {
        providerName: 'Provider renamed', connectionName: 'Provider renamed',
        connectionRole: 'default', connectionDisplayNameMode: 'automatic',
      },
    }))).toBe('benign_change');
  });

  it('requires an explicit decision when the security fingerprint changes', () => {
    expect(compareSessionProviderBindingV1(binding(), binding({
      bindingSecurityFingerprint: 'binding-security:v1:b',
    }))).toBe('security_change');
  });

  it('keeps source and credential changes distinct from admitted model and declaration changes', () => {
    const basis = { v: 1 as const, deployment: { kind: 'external' as const },
      agentTargetKey: 'agent:codex', connectionId: binding().connectionId, contributionKey: binding().contributionKey,
      endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses' as const, publicHeaders: {} }, runtimeCredentialTransport: null,
      prepared: { v: 1 as const, materialization: 'engineConfig' as const, adapterBindingKey: 'p_pc_a' }, adapterVersion: 1,
      agentSupport: { acceptsProtocols: ['openai-responses' as const], required: {},
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] }, materialization: 'engineConfig' as const,
        applyPolicy: 'restart_session' as const, supportsFreeformModelIds: true },
      credentialAuthorization: { connectionSecurityFingerprint: 'connection:v1:a', grantFingerprint: 'grant:v1:a',
        selectedSecretBindingId: null, selectedSecretRecordFingerprint: null } };
    const metadata = (adapterVersion: number, url = basis.endpoint.normalizedUrl, modelId = 'model-a') => SessionProviderBindingMetadataV1Schema.parse({
      ...binding(), model: { id: modelId, name: modelId, capabilities: { reasoningControls: adapterVersion === 1 ? 'unknown' : 'supported' } },
      runtimeBindingBasis: { ...basis, adapterVersion, endpoint: { ...basis.endpoint, normalizedUrl: url } },
      compatibilityFingerprint: `compatibility:v1:${adapterVersion}`,
      bindingSecurityFingerprint: createProviderBindingSecurityFingerprintV1({ agentTargetKey: basis.agentTargetKey,
        connectionId: basis.connectionId, modelId, modelCapabilities: {},
        endpointTemplateId: basis.endpoint.endpointTemplateId, endpointUrl: url, protocol: basis.endpoint.protocol,
        publicHeaders: {}, materialization: 'engineConfig', adapterBindingKey: basis.prepared.adapterBindingKey,
        adapterVersion, compatibilityFingerprint: `compatibility:v1:${adapterVersion}` }),
    });
    // Retain the actual producer's declaration-sensitive hash from before the update.
    const previous = metadata(1);
    expect(compareSessionProviderBindingV1(previous, metadata(2))).toBe('benign_change');
    expect(compareSessionProviderBindingV1(previous, metadata(2, 'https://other.example/v1'))).toBe('security_change');
    const changedCredentialDestination = SessionProviderBindingMetadataV1Schema.parse({ ...metadata(2),
      runtimeBindingBasis: { ...basis, runtimeCredentialTransport: { id: 'api-key', uses: ['runtime'], protocols: ['openai-responses'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } } },
    });
    expect(compareSessionProviderBindingV1(previous, changedCredentialDestination)).toBe('security_change');
    expect(compareSessionProviderBindingV1(previous, { ...metadata(2), contributionKey: 'other/plugin' })).toBe('security_change');
  });

  it('distinguishes a different connection from a same-connection security edit', () => {
    expect(compareSessionProviderBindingV1(binding(), binding({
      connectionId: 'pc_b', bindingSecurityFingerprint: 'binding-security:v1:b',
    }))).toBe('connection_change');
  });
});

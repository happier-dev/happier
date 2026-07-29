import { describe, expect, it } from 'vitest';

import { compareSessionProviderBindingV1 } from './lifecycle.js';
import { SessionProviderBindingMetadataV1Schema } from './bindingMetadataV1.js';

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

  it('distinguishes a different connection from a same-connection security edit', () => {
    expect(compareSessionProviderBindingV1(binding(), binding({
      connectionId: 'pc_b', bindingSecurityFingerprint: 'binding-security:v1:b',
    }))).toBe('connection_change');
  });
});

import { describe, expect, it } from 'vitest';

import {
  applySessionProviderBindingMetadataV1,
  readSessionProviderBindingMetadataV1,
  SESSION_PROVIDER_BINDING_METADATA_KEY_V1,
} from './bindingMetadataV1.js';

const binding = {
  v: 1 as const,
  connectionId: 'pc_work',
  contributionKey: 'plugin:openrouter:openrouter',
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
  it('owns one canonical metadata key and ignores malformed persisted values', () => {
    const metadata = applySessionProviderBindingMetadataV1({ path: '/tmp' }, binding);

    expect(metadata[SESSION_PROVIDER_BINDING_METADATA_KEY_V1]).toEqual(binding);
    expect(readSessionProviderBindingMetadataV1(metadata)).toEqual(binding);
    expect(readSessionProviderBindingMetadataV1({
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: { ...binding, bindingSecurityFingerprint: '' },
    })).toBeNull();
  });

  it('removes the canonical binding key when a native restart clears the provider binding', () => {
    expect(applySessionProviderBindingMetadataV1({
      path: '/tmp',
      [SESSION_PROVIDER_BINDING_METADATA_KEY_V1]: binding,
    }, null)).toEqual({ path: '/tmp' });
  });
});

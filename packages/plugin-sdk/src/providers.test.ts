import { describe, expect, it } from 'vitest';

import {
  buildBackendTargetKeyV2,
  normalizeProviderCredentialHeaderName,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
} from './providers.js';

describe('experimental Provider SDK boundary', () => {
  it('reuses protocol-owned endpoint and header validation without a second validator', () => {
    expect(ProviderEndpointUrlSyntaxSchema.safeParse('https://gateway.example/v1').success).toBe(true);
    expect(ProviderEndpointUrlSyntaxSchema.safeParse('file:///tmp/secret').success).toBe(false);
    expect(ProviderPublicHeadersV1Schema.safeParse({ 'x-tenant': 'work' }).success).toBe(true);
    expect(normalizeProviderCredentialHeaderName('X-API-Key')).toBe('x-api-key');
    expect(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' })).toBe('backend:codex');
    expect(SessionModelSelectionV1Schema).toBeDefined();
    expect(resolveSessionModelSelectionIntentV1).toBeTypeOf('function');
    expect(SessionModelSelectionResolutionError).toBeTypeOf('function');
  });
});

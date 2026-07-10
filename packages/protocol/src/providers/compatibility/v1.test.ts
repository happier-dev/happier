import { describe, expect, it } from 'vitest';

import { ProviderCompatibilityEvidenceV1Schema } from '../capabilities/v1.js';
import { AgentProviderRequirementsV1Schema } from './v1.js';

const requirements = {
  acceptsProtocols: ['openai-responses'], required: {},
  credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
  authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['OPENAI_API_KEY'] },
  materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
} as const;

describe('provider compatibility contracts', () => {
  it('allows only HTTPS evidence links', () => {
    expect(ProviderCompatibilityEvidenceV1Schema.safeParse({
      sourceUrls: ['javascript:alert(1)'], verifiedAt: '2026-07-10',
    }).success).toBe(false);
    expect(ProviderCompatibilityEvidenceV1Schema.safeParse({
      sourceUrls: ['https://docs.example.test/provider'], verifiedAt: '2026-07-10',
    }).success).toBe(true);
  });

  it('uses canonical uppercase environment ownership keys so Windows aliases cannot collide', () => {
    expect(AgentProviderRequirementsV1Schema.safeParse({
      ...requirements,
      authIsolation: { ...requirements.authIsolation, ownedEnvKeys: ['PATH', 'Path'] },
    }).success).toBe(false);
  });

  it('treats header support names as case-insensitive and query support names as case-sensitive', () => {
    expect(AgentProviderRequirementsV1Schema.safeParse({
      ...requirements,
      credentialSupport: {
        ...requirements.credentialSupport,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: { kind: 'httpHeader', names: ['Authorization', 'authorization'], formats: ['bearer'] },
        }],
      },
    }).success).toBe(false);
    expect(AgentProviderRequirementsV1Schema.safeParse({
      ...requirements,
      credentialSupport: {
        ...requirements.credentialSupport,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: { kind: 'queryParam', names: ['API_KEY', 'api_key'], formats: ['raw'] },
        }],
      },
    }).success).toBe(true);
  });

  it('normalizes valid transport support names and rejects invalid destination syntax', () => {
    const parsed = AgentProviderRequirementsV1Schema.parse({
      ...requirements,
      credentialSupport: {
        ...requirements.credentialSupport,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: { kind: 'httpHeader', names: ['Authorization', 'X-Api-Key'], formats: ['bearer'] },
        }, {
          protocol: 'openai-responses',
          destination: { kind: 'queryParam', names: ['API_KEY'], formats: ['raw'] },
        }],
      },
    });
    expect(parsed.credentialSupport.apiKeyTransports[0]?.destination.names).toEqual(['authorization', 'x-api-key']);
    expect(parsed.credentialSupport.apiKeyTransports[1]?.destination.names).toEqual(['API_KEY']);

    for (const destination of [
      { kind: 'httpHeader', names: ['Bad Header'], formats: ['raw'] },
      { kind: 'httpHeader', names: ['Host'], formats: ['raw'] },
      { kind: 'queryParam', names: ['bad\nquery'], formats: ['raw'] },
    ]) {
      expect(AgentProviderRequirementsV1Schema.safeParse({
        ...requirements,
        credentialSupport: {
          ...requirements.credentialSupport,
          apiKeyTransports: [{ protocol: 'openai-responses', destination }],
        },
      }).success).toBe(false);
    }
  });
});

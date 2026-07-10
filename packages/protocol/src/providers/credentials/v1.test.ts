import { describe, expect, it } from 'vitest';

import { ProviderApiKeyCredentialRequirementV1Schema, ProviderCredentialDestinationV1Schema } from './v1.js';

describe('ProviderCredentialDestinationV1Schema', () => {
  it('returns canonical destination names for materialization', () => {
    expect(ProviderCredentialDestinationV1Schema.parse({
      kind: 'httpHeader', name: ' X-API-Key ', format: 'raw',
    })).toEqual({ kind: 'httpHeader', name: 'x-api-key', format: 'raw' });
    expect(ProviderCredentialDestinationV1Schema.parse({
      kind: 'queryParam', name: ' api_key ', format: 'raw',
    })).toEqual({ kind: 'queryParam', name: 'api_key', format: 'raw' });
  });

  it('rejects case-equivalent header transports but permits case-distinct query transports', () => {
    const transport = {
      id: 'one', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    } as const;
    expect(ProviderApiKeyCredentialRequirementV1Schema.safeParse({
      kind: 'apiKey', transports: [transport, {
        ...transport, id: 'two', destination: { ...transport.destination, name: 'authorization' },
      }],
    }).success).toBe(false);

    const queryTransport = {
      id: 'one', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'queryParam', name: 'API_KEY', format: 'raw' },
    } as const;
    expect(ProviderApiKeyCredentialRequirementV1Schema.safeParse({
      kind: 'apiKey', transports: [queryTransport, {
        ...queryTransport, id: 'two', destination: { ...queryTransport.destination, name: 'api_key' },
      }],
    }).success).toBe(true);
  });
});

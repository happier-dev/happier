import { describe, expect, it } from 'vitest';

import { ProviderApiKeyCredentialRequirementV1Schema, ProviderCredentialDestinationV1Schema } from './v1.js';

describe('ProviderCredentialDestinationV1Schema', () => {
  it('admits independent required companion secrets on one selected transport', () => {
    const result = ProviderApiKeyCredentialRequirementV1Schema.parse({
      kind: 'apiKey', transports: [{
        id: 'gateway', protocols: ['anthropic'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'x-gateway-token', format: 'bearer' },
        additionalCredentials: [{
          slotId: 'upstreamKey',
          destination: { kind: 'httpHeader', name: 'X-API-Key', format: 'raw' },
        }],
      }],
    });
    expect(result.transports[0]).toMatchObject({ additionalCredentials: [{
      slotId: 'upstreamKey', destination: { name: 'x-api-key', format: 'raw' },
    }] });
  });

  it('refuses companion destination collisions and primary-slot reuse', () => {
    const transport = {
      id: 'gateway', protocols: ['anthropic'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-gateway-token', format: 'bearer' },
    };
    for (const additionalCredentials of [
      [{ slotId: 'upstreamKey', destination: { kind: 'httpHeader', name: 'X-GATEWAY-TOKEN', format: 'raw' } }],
      [{ slotId: 'apiKey', destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }],
      ['x-api-key', 'x-other-key'].map(name => ({ slotId: 'upstreamKey', destination: { kind: 'httpHeader', name, format: 'raw' } })),
    ]) {
      expect(ProviderApiKeyCredentialRequirementV1Schema.safeParse({
        kind: 'apiKey', transports: [{ ...transport, additionalCredentials }],
      }).success).toBe(false);
    }
  });

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

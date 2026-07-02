import { describe, expect, it } from 'vitest';

import { PluginHostedWebEndpointRefV1Schema } from './hostedWebEndpoint.js';

describe('hosted web endpoint refs', () => {
  it('accepts access endpoint references and rejects raw URLs', () => {
    expect(PluginHostedWebEndpointRefV1Schema.parse({
      kind: 'accessEndpoint',
      endpointId: 'endpoint-1',
      origin: 'https://preview.example.test',
    })).toMatchObject({ kind: 'accessEndpoint', endpointId: 'endpoint-1' });

    expect(PluginHostedWebEndpointRefV1Schema.safeParse({
      kind: 'url',
      url: 'http://127.0.0.1:5173',
    }).success).toBe(false);
  });

  it('rejects non-http access endpoint origins', () => {
    expect(PluginHostedWebEndpointRefV1Schema.safeParse({
      kind: 'accessEndpoint',
      endpointId: 'endpoint-1',
      origin: 'ftp://preview.example.test',
    }).success).toBe(false);
  });

  it('rejects access endpoint origins that include paths', () => {
    expect(PluginHostedWebEndpointRefV1Schema.safeParse({
      kind: 'accessEndpoint',
      endpointId: 'endpoint-1',
      origin: 'https://preview.example.test/app',
    }).success).toBe(false);
  });
});

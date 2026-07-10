import { describe, expect, it } from 'vitest';

import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';

const unknownCapabilities = {
  streaming: 'unknown',
  toolRoundTrips: 'unknown',
  statefulResponses: 'unknown',
  reasoningControls: 'unknown',
} as const;

function validTemplate() {
  return {
    v: 1,
    name: 'Company gateway',
    endpointTemplates: [{
      id: 'chat',
      protocol: 'openai-chat',
      baseUrl: 'https://gateway.example/v1',
      capabilities: unknownCapabilities,
    }],
    credential: {
      kind: 'apiKey',
      transports: [{
        id: 'key',
        protocols: ['openai-chat'],
        uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
      }],
    },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' },
  } as const;
}

describe('CustomProviderTemplateV1Schema', () => {
  it('accepts only concrete URLs, unknown capabilities, safe header auth and manual/probe catalogs', () => {
    expect(CustomProviderTemplateV1Schema.parse(validTemplate())).toMatchObject({ name: 'Company gateway' });
  });

  it.each([
    ['asserted capability', (value: any) => { value.endpointTemplates[0].capabilities.streaming = 'supported'; }],
    ['local candidates', (value: any) => { delete value.endpointTemplates[0].baseUrl; value.endpointTemplates[0].localUrlCandidates = ['http://127.0.0.1:1']; }],
    ['query credential', (value: any) => { value.credential.transports[0].destination = { kind: 'queryParam', name: 'key', format: 'raw' }; }],
    ['template credential', (value: any) => { value.credential.transports[0].destination.format = { template: 'Token {secret}' }; }],
    ['management use', (value: any) => { value.credential.transports[0].uses.push('management'); }],
    ['static catalog', (value: any) => { value.catalog = { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'x', name: 'X' }] }; }],
    ['discovery', (value: any) => { value.discovery = {}; }],
    ['compatibility override', (value: any) => { value.compatibilityOverrides = {}; }],
    ['model management', (value: any) => { value.modelLoad = {}; }],
  ])('rejects contribution-only trust fact: %s', (_name, mutate) => {
    const value = structuredClone(validTemplate()) as any;
    mutate(value);
    expect(CustomProviderTemplateV1Schema.safeParse(value).success).toBe(false);
  });

  it('rejects duplicate or ambiguous custom credential transports at authoring time', () => {
    const value = structuredClone(validTemplate()) as any;
    value.credential.transports.push({ ...value.credential.transports[0], id: 'duplicate' });
    expect(CustomProviderTemplateV1Schema.safeParse(value).success).toBe(false);
  });

  it.each([
    'https://user:secret@gateway.example/v1',
    'ftp://gateway.example/v1',
    'https://gateway.example/v1?api_key=secret',
    'https://gateway.example/v1?api-version=2026-01-01',
    'http://169.254.169.254/latest/meta-data',
  ])('rejects an unsafe persisted endpoint URL: %s', (baseUrl) => {
    const value = structuredClone(validTemplate()) as any;
    value.endpointTemplates[0].baseUrl = baseUrl;
    expect(CustomProviderTemplateV1Schema.safeParse(value).success).toBe(false);
  });

  it('rejects secrets in catalog probe paths while preserving benign version parameters', () => {
    const invalid = structuredClone(validTemplate()) as any;
    invalid.catalog = {
      source: 'probe', manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'chat', path: '/v1/models?api_key=secret', parser: 'openai-models' }],
    };
    expect(CustomProviderTemplateV1Schema.safeParse(invalid).success).toBe(false);
    invalid.catalog.probes[0].path = '/openai/models?api-version=2026-01-01';
    expect(CustomProviderTemplateV1Schema.parse(invalid).catalog).toMatchObject({
      probes: [{ path: '/openai/models?api-version=2026-01-01' }],
    });
  });
});

import { describe, expect, it } from 'vitest';

import { normalizeCustomProviderAdvancedTemplateV1, normalizeCustomProviderTemplateV1 } from './normalizeCustomTemplateV1.js';

describe('normalizeCustomProviderTemplateV1', () => {
  it('normalizes the OpenAI Responses simple form without asserting capabilities', () => {
    expect(normalizeCustomProviderTemplateV1({
      name: 'Company gateway',
      protocol: 'openai-responses',
      baseUrl: 'https://gateway.example/prefix/v1/',
      credentialStyle: 'bearer',
      catalog: 'probe',
      modelsPath: '/models',
    })).toEqual({
      v: 1,
      name: 'Company gateway',
      endpointTemplates: [{
        id: 'openai-responses',
        protocol: 'openai-responses',
        baseUrl: 'https://gateway.example/prefix/v1/',
        capabilities: {
          streaming: 'unknown',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        required: true,
        transports: [{
          id: 'openai-responses-runtime-probe',
          protocols: ['openai-responses'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'openai-responses', path: '/models', parser: 'openai-models' }],
      },
    });
  });

  it('keeps Anthropic custom providers manual by default and supports no-auth', () => {
    expect(normalizeCustomProviderTemplateV1({
      name: 'Local Anthropic bridge',
      protocol: 'anthropic',
      baseUrl: 'http://localhost:4040/v1',
      catalog: 'manual',
    })).toMatchObject({
      endpointTemplates: [{ protocol: 'anthropic' }],
      catalog: { source: 'manual' },
    });
  });

  it('requires a validated header only for custom-header credentials', () => {
    expect(() => normalizeCustomProviderTemplateV1({
      name: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1',
      credentialStyle: 'custom-header', catalog: 'manual',
    })).toThrow(/credential header/i);
    expect(() => normalizeCustomProviderTemplateV1({
      name: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1',
      credentialStyle: 'bearer', credentialHeader: 'X-Should-Not-Be-Used', catalog: 'manual',
    })).toThrow(/only valid/i);
    expect(normalizeCustomProviderTemplateV1({
      name: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1',
      credentialStyle: 'custom-header-bearer', credentialHeader: 'X-Gateway-Key', catalog: 'manual',
    }).credential?.transports[0]?.destination).toEqual({
      kind: 'httpHeader', name: 'x-gateway-key', format: 'bearer',
    });
  });

  it('normalizes multiple protocol endpoints, safe public headers, per-protocol credentials, and bounded probes', () => {
    const template = normalizeCustomProviderAdvancedTemplateV1({
      name: 'Company gateway',
      endpoints: [
        {
          protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
          publicHeaders: { 'X-Tenant': 'engineering' }, credentialStyle: 'bearer',
        },
        {
          protocol: 'anthropic', baseUrl: 'https://gateway.example/anthropic',
          credentialStyle: 'x-api-key',
        },
      ],
      probes: [
        { protocol: 'openai-responses', path: '/models', parser: 'openai-models' },
        { protocol: 'anthropic', path: '/model-catalog', parser: 'openai-models' },
      ],
    });

    expect(template.endpointTemplates).toMatchObject([
      { id: 'openai-responses', protocol: 'openai-responses', publicHeaders: { 'x-tenant': 'engineering' } },
      { id: 'anthropic', protocol: 'anthropic' },
    ]);
    expect(template.credential?.transports).toEqual([
      {
        id: 'openai-responses-runtime-probe', protocols: ['openai-responses'], uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
      {
        id: 'anthropic-runtime-probe', protocols: ['anthropic'], uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
      },
    ]);
    expect(template.catalog).toMatchObject({ source: 'probe', probes: [{ endpointTemplateId: 'openai-responses' }, { endpointTemplateId: 'anthropic' }] });
  });

  it('rejects duplicate protocol endpoints, probe references without endpoints, and more than three probes', () => {
    const endpoint = { protocol: 'openai-chat' as const, baseUrl: 'https://gateway.example/v1' };
    expect(() => normalizeCustomProviderAdvancedTemplateV1({ name: 'Duplicate', endpoints: [endpoint, endpoint], probes: [] }))
      .toThrow(/duplicate/i);
    expect(() => normalizeCustomProviderAdvancedTemplateV1({
      name: 'Missing', endpoints: [endpoint],
      probes: [{ protocol: 'anthropic', path: '/models', parser: 'openai-models' }],
    })).toThrow(/declared endpoint/i);
    expect(() => normalizeCustomProviderAdvancedTemplateV1({
      name: 'Too many', endpoints: [endpoint], probes: [1, 2, 3, 4].map((index) => ({
        protocol: 'openai-chat' as const, path: `/models-${index}`, parser: 'openai-models' as const,
      })),
    })).toThrow();
  });
});

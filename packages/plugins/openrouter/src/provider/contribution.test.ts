import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OPENROUTER_PROVIDER_CONTRIBUTION', () => {
  it('declares Chat and stateless Responses with a probe-only catalog', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'openrouter',
      kind: 'aggregator',
      endpointTemplates: [
        { id: 'openrouter-openai-chat', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' },
        {
          id: 'openrouter-openai-responses',
          protocol: 'openai-responses',
          baseUrl: 'https://openrouter.ai/api/v1',
          capabilities: { statefulResponses: 'unsupported' },
        },
      ],
      credential: {
        kind: 'apiKey',
        keyUrl: 'https://openrouter.ai/keys',
        transports: [{
          id: 'openrouter-http-bearer',
          protocols: ['openai-chat', 'openai-responses'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'probe',
        probes: [{ endpointTemplateId: 'openrouter-openai-responses', path: '/api/v1/models', parser: 'openai-models' }],
      },
    });
  });
});

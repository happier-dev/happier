import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('LMSTUDIO_PROVIDER_CONTRIBUTION', () => {
  it('declares verified local protocols, ordered catalog fallback, and explicit model loading', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'lmstudio',
      kind: 'local',
      endpointTemplates: [
        { id: 'lmstudio-openai-responses', protocol: 'openai-responses' },
        {
          id: 'lmstudio-openai-chat',
          protocol: 'openai-chat',
          capabilities: { reasoningControls: 'unknown' },
        },
        {
          id: 'lmstudio-anthropic',
          protocol: 'anthropic',
          localUrlCandidates: ['http://127.0.0.1:1234', 'http://localhost:1234'],
        },
      ],
      credential: {
        kind: 'apiKey',
        required: false,
        transports: [{
          id: 'lmstudio-http-bearer',
          protocols: ['openai-chat', 'openai-responses', 'anthropic'],
          uses: ['probe', 'runtime', 'management'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'probe',
        probes: [
          { endpointTemplateId: 'lmstudio-openai-responses', path: '/api/v1/models', parser: 'lmstudio-native-models' },
          { endpointTemplateId: 'lmstudio-openai-responses', path: '/v1/models', parser: 'openai-models' },
        ],
      },
      modelLoad: {
        endpointTemplateId: 'lmstudio-openai-responses',
        path: '/api/v1/models/load',
        request: 'json-model-id-v1',
        confirmation: 'refresh-catalog-load-state',
        preflightPolicy: 'advisory',
      },
    });
  });

  it('detects only verified process facts and never claims managed ownership', () => {
    const contribution = PLUGIN_MANIFEST.contributes.providers[0];
    expect(contribution.discovery).toMatchObject({
      listener: { executableBasenames: ['llmster'], defaultPorts: [1234] },
      presenceCheck: { lookupNames: ['lms'], fixedArgs: ['daemon', 'status', '--json'], parser: 'lms-status-json' },
    });
    expect(contribution.discovery).not.toHaveProperty('managedStart');
  });
});

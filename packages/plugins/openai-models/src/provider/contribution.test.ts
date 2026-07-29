import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OPENAI_PROVIDER_CONTRIBUTION', () => {
  it('declares official Chat and Responses endpoints with one bearer-backed model catalog', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'openai',
      kind: 'frontier',
      endpointTemplates: [
        { id: 'openai-chat', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1' },
        {
          id: 'openai-responses', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
          capabilities: { statefulResponses: 'supported' },
        },
      ],
      credential: {
        kind: 'apiKey', required: true, keyUrl: 'https://platform.openai.com/api-keys',
        transports: [{
          id: 'openai-http-bearer', protocols: ['openai-chat', 'openai-responses'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'openai-responses', path: '/v1/models', parser: 'openai-models' }],
      },
      legacyProfileMigrations: [{
        sourceProfileId: 'openai',
        credentialBinding: { legacyEnvVarName: 'OPENAI_API_KEY', credentialSlotId: 'apiKey' },
        primaryModel: { agentTargetKey: 'agent:codex', legacyEnvVarName: 'OPENAI_MODEL', defaultModelId: 'gpt-5-codex-high' },
      }],
    });
  });
});

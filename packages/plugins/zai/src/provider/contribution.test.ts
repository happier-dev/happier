import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('ZAI_PROVIDER_CONTRIBUTION', () => {
  it('declares both official Coding Plan protocols without inventing a catalog probe', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'zai',
      kind: 'frontier',
      endpointTemplates: [
        { id: 'zai-anthropic', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' },
        { id: 'zai-openai-chat', protocol: 'openai-chat', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
      ],
      credential: {
        kind: 'apiKey',
        transports: [{
          id: 'zai-http-bearer',
          protocols: ['anthropic', 'openai-chat'],
          uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'static',
        staticModels: [
          { id: 'glm-5.2', name: 'GLM-5.2' },
          { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
          { id: 'glm-4.7', name: 'GLM-4.7' },
        ],
      },
      legacyProfileMigrations: [{
        sourceProfileId: 'zai',
        credentialBinding: { legacyEnvVarName: 'Z_AI_AUTH_TOKEN', credentialSlotId: 'apiKey' },
        primaryModel: { agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL', defaultModelId: 'GLM-4.6' },
      }],
    });
  });
});

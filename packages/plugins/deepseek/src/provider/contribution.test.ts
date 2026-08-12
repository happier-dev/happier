import { describe, expect, it } from 'vitest';
import { mergeProviderCatalogV1 } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('DEEPSEEK_PROVIDER_CONTRIBUTION', () => {
  it('keeps Anthropic and OpenAI credential semantics protocol-specific', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'deepseek',
      kind: 'frontier',
      endpointTemplates: [
        { id: 'deepseek-anthropic', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
        { id: 'deepseek-openai-chat', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1' },
      ],
      credential: {
        kind: 'apiKey',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        transports: [
          {
            id: 'deepseek-anthropic-x-api-key',
            protocols: ['anthropic'],
            uses: ['runtime'],
            destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
          },
          {
            id: 'deepseek-openai-bearer',
            protocols: ['openai-chat'],
            uses: ['probe', 'runtime'],
            destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
          },
        ],
      },
      catalog: {
        source: 'static+probe',
        probes: [{ endpointTemplateId: 'deepseek-openai-chat', path: '/v1/models', parser: 'openai-models' }],
      },
      legacyProfileMigrations: [{
        sourceProfileId: 'deepseek',
        descriptorRevision: 2,
        credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
        primaryModel: { agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL', defaultModelId: 'deepseek-v4-flash' },
        implicitModelAliasReplacements: [
          { legacyModelId: 'deepseek-chat', replacementModelId: 'deepseek-v4-flash' },
          { legacyModelId: 'deepseek-reasoner', replacementModelId: 'deepseek-v4-flash' },
        ],
        migratedEnvironmentVariables: expect.arrayContaining([
          { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-v4-flash}' },
        ]),
        retainedEnvironmentVariables: expect.arrayContaining([
          { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-v4-flash}' },
        ]),
      }],
    });
  });

  it('keeps an omitted membership policy on the existing augmenting static+probe union', () => {
    const catalog = PLUGIN_MANIFEST.contributes.providers[0]?.catalog;
    expect(catalog).not.toHaveProperty('membershipPolicy');
    expect(catalog?.source).toBe('static+probe');
    if (catalog?.source !== 'static+probe') throw new Error('Expected DeepSeek static+probe catalog');

    expect(mergeProviderCatalogV1({
      staticModels: catalog.staticModels,
      manualModels: [],
      probeState: {
        snapshot: {
          models: [{ id: 'deepseek-account-model', name: 'Account model' }],
          observedAt: 20,
          stale: false,
        },
        staleProbeModels: [],
      },
    }).rows.map((row) => row.descriptor.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-account-model',
    ]);
  });
});

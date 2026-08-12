import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';

import { CLAUDE_STATIC_MODELS } from '../agent/models.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { ANTHROPIC_PROVIDER_CONTRIBUTION } from './contribution.js';
import {
  readAndAssertBundledProviderVerificationsV1,
} from '../../../../../scripts/migrations/extensions/bundledProviderVerification.ts';

describe('Anthropic Provider contribution', () => {
  it('uses the selected Provider endpoint and credential for a static+probe catalog', () => {
    const contribution = PLUGIN_MANIFEST.contributes.providers?.find(({ id }) => id === 'anthropic');

    expect(contribution).toMatchObject({
      v: 1,
      id: 'anthropic',
      endpointTemplates: [{
        id: 'anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com/',
        publicHeaders: { 'anthropic-version': '2023-06-01' },
      }],
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        transports: [{
          id: 'anthropic-x-api-key',
          protocols: ['anthropic'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
        }],
      },
      catalog: {
        source: 'static+probe',
        manualModelPolicy: 'allowed',
        membershipPolicy: 'probe-authoritative',
        probes: [{
          endpointTemplateId: 'anthropic',
          path: '/v1/models?limit=1000',
          parser: 'anthropic-models',
        }],
      },
    });
    expect(contribution).toEqual(ANTHROPIC_PROVIDER_CONTRIBUTION);
    expect(() => ProviderContributionV1Schema.parse(ANTHROPIC_PROVIDER_CONTRIBUTION)).not.toThrow();
    expect(contribution?.catalog.source === 'static+probe' && contribution.catalog.staticModels)
      .toEqual(CLAUDE_STATIC_MODELS);
    expect(contribution?.catalog.source === 'static+probe'
      && contribution.catalog.staticModels.find(({ id }) => id === 'claude-opus-4-6'))
      .toMatchObject({
        modelOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'reasoning_effort' }),
        ]),
      });
    expect(contribution?.catalog.source === 'static+probe'
      && contribution.catalog.staticModels.find(({ id }) => id === 'claude-sonnet-4-6'))
      .toMatchObject({ extendedContextModelId: expect.any(String) });
  });

  it('has complete current first-party verification evidence', () => {
    expect(readAndAssertBundledProviderVerificationsV1({
      buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      rootDir: fileURLToPath(new URL('../../../../../', import.meta.url)),
      pluginPackageId: 'claude',
      pluginId: 'happier.agent.claude',
      contributions: [ANTHROPIC_PROVIDER_CONTRIBUTION],
      todayUtc: '2026-08-12',
    })).toHaveLength(1);
  });
});

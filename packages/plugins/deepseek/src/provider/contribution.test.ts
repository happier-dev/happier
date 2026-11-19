import { describe, expect, it } from 'vitest';
import { budgetInlineCompletionContext, mergeProviderCatalogV1 } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from '../manifest.js';
import * as plugin from '../manifest.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ProviderUsageParseResultV1Schema } from '@happier-dev/protocol/providers/contributions';

describe('DEEPSEEK_PROVIDER_CONTRIBUTION', () => {
  it('registers the balance reader and admits separate denominated balances without a cap or conversion', async () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]?.usageSources).toEqual([
      { id: 'balance', endpointTemplateId: 'deepseek-openai-chat', path: '/user/balance', parser: 'deepseek-balance' },
    ]);
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: plugin });
    try {
      const parse = kit.registration('providers', 'deepseek')?.usageParsers?.['deepseek-balance'];
      expect(parse).toBeTypeOf('function');
      if (!parse) throw new Error('Missing DeepSeek balance parser');
      const result = ProviderUsageParseResultV1Schema.parse(parse({ is_available: true, balance_infos: [
        { currency: 'CNY', total_balance: '-0.0123', granted_balance: '0.00', topped_up_balance: '-0.0123' },
        { currency: 'USD', total_balance: '110.50', granted_balance: '10.00', topped_up_balance: '100.50' },
      ] }));
      expect(result.meters).toMatchObject([
        { meterId: 'balance-CNY', remaining: -0.0123, currency: 'CNY', unit: 'unknown', used: null, limit: null, utilizationPct: null, limitScope: 'account' },
        { meterId: 'balance-USD', remaining: 110.5, currency: 'USD', unit: 'usd', used: null, limit: null, utilizationPct: null, limitScope: 'account' },
      ]);
      expect(parse({ is_available: false, balance_infos: [] }).meters).toEqual([]);
      for (const total_balance of ['', '  ', 'NaN', 'Infinity', '0x10', 4, null]) {
        expect(() => parse({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance }] })).toThrow();
      }
      expect(() => parse({ is_available: true })).toThrow();
    } finally { await kit.dispose(); }
  });
  it('advertises inline FIM only on the proven current model identity without changing legacy chat aliases', () => {
    const catalog = PLUGIN_MANIFEST.contributes.providers[0]?.catalog;
    if (catalog?.source !== 'static+probe') throw new Error('Expected DeepSeek static+probe catalog');
    expect(catalog.staticModels.filter(model => 'inlineCompletion' in model).map(model => model.id)).toEqual(['deepseek-v4-pro']);
    expect(new Set(catalog.staticModels.map(model => model.id)).size).toBe(catalog.staticModels.length);
    expect(catalog.staticModels.find(model => model.id === 'deepseek-v4-flash')).toMatchObject({ aliases: ['deepseek-chat', 'deepseek-reasoner'] });
    const fim = catalog.staticModels.find(model => model.id === 'deepseek-v4-pro');
    expect(fim).toMatchObject({
      upstreamRef: { vendor: 'deepseek', vendorModelId: 'deepseek-v4-pro' },
      inlineCompletion: { outputTokens: 4096 },
    });
    expect(fim && budgetInlineCompletionContext(fim, { prefix: '', suffix: '' })).not.toBeNull();
  });

  it('keeps Anthropic and OpenAI credential semantics protocol-specific', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'deepseek',
      kind: 'frontier',
      endpointTemplates: [
        { id: 'deepseek-fim', protocol: 'openai-completions', baseUrl: 'https://api.deepseek.com/beta' },
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
            protocols: ['openai-chat', 'openai-completions'],
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

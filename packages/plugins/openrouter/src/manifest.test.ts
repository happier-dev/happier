import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ProviderUsageParseResultV1Schema } from '@happier-dev/protocol/providers/contributions';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST, activate } from './manifest.js';

describe('OpenRouter plugin manifest', () => {
  it('registers the request-cost decoder only for the documented Chat transport', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(PLUGIN_MANIFEST.contributes.providers[0]!.requestCost)
        .toEqual({ endpointTemplateIds: ['openrouter-openai-chat'] });
      expect(kit.registration('providers', 'openrouter')?.requestCostParser?.({ cost: 0.12,
        cost_details: { upstream_inference_cost: 9 } })).toBe(0.12);
    } finally { await kit.dispose(); }
  });
  it('is a declarative first-party provider plugin with no runtime permissions', async () => {
    await expect(import('./manifest.js').then((module) => PluginManifestV2Schema.parse(module.PLUGIN_MANIFEST))).resolves.toMatchObject({
      id: 'happier.provider.openrouter',
      hostAccess: { required: [], optional: [] },
      contributes: { providers: [{ id: 'openrouter' }] },
    });
  });

  it('uses only the strict data-only root and survives bundled or installed ingestion', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toEqual(
      ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST)),
    );
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST).ok).toBe(true);
  });

  it('binds both real usage sources to parsers that produce admitted Q1 money facts', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const parsers = kit.registration('providers', 'openrouter')?.usageParsers;
      for (const source of PLUGIN_MANIFEST.contributes.providers[0]!.usageSources!) {
        const body = source.billingCredential ? { data: { total_credits: 10, total_usage: 12 } }
          : { data: { usage_daily: 1, usage_weekly: 2, usage_monthly: 3, usage: 4, limit: null, limit_remaining: null } };
        const result = ProviderUsageParseResultV1Schema.parse(parsers?.[source.parser]?.(body));
        expect(result.meters.length).toBeGreaterThan(0);
        expect(result.meters.every(meter => meter.unit === 'usd')).toBe(true);
      }
    } finally { await kit.dispose(); }
  });

  it('activates declared usage parsers through the Provider family', () => {
    const providerFamily = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers');
    expect(providerFamily).toMatchObject({
      identityKind: 'delegatedDomain',
      disposition: 'delegated',
      activationDemand: 'conditional',
      allowedRuntimeRegistration: 'providers',
    });
    expect(providerFamily?.projectIntrospection(PLUGIN_MANIFEST.contributes.providers[0])).toMatchObject({
      localId: null,
      registration: 'required',
    });
  });
});

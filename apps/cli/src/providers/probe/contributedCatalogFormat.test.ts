import { describe, expect, it } from 'vitest';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST as vercelManifest, activate as activateVercel } from '../../../../../packages/plugins/vercel-ai-gateway/src/manifest';
import vercelCatalog from '../../../../../packages/plugins/vercel-ai-gateway/src/provider/catalog/fixtures/catalog.json';
import { PLUGIN_MANIFEST as ollamaManifest, activate as activateOllama } from '../../../../../packages/plugins/ollama/src/manifest';
import { PLUGIN_MANIFEST as lmstudioManifest, activate as activateLmstudio } from '../../../../../packages/plugins/lmstudio/src/manifest';
import { CLAUDE_PLUGIN, PLUGIN_MANIFEST as claudeManifest } from '../../../../../packages/plugins/claude/src/manifest';
import { parseProviderCatalogResponse } from './parsers';
import { createProviderLocalCatalogFallbackRunner } from './localCommand';

import {
  createProviderProbeHttpClient,
  type ProviderProbeTransport,
} from './client';

/**
 * A synthetic third-party Provider plugin: it declares a catalog wire format
 * Happier does not bundle and contributes that format's implementation through
 * the ordinary `providers` contribution family. Nothing here is reachable only
 * to a bundled plugin.
 */
const acmePlugin = definePlugin({
  id: 'acme.models',
  version: '1.0.0',
  displayName: 'Acme Models',
  engines: { happier: '^0.2.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './daemon.mjs' },
  providers: {
    acme: {
      declaration: {
        v: 1,
        name: 'Acme',
        kind: 'cloud',
        endpointTemplates: [{
          id: 'acme-openai-chat',
          protocol: 'openai-chat',
          baseUrl: 'https://api.acme.example/v1',
          capabilities: {
            streaming: 'supported',
            toolRoundTrips: 'supported',
            statefulResponses: 'unsupported',
            reasoningControls: 'unknown',
          },
        }],
        catalog: {
          source: 'probe',
          manualModelPolicy: 'allowed',
          probes: [{
            endpointTemplateId: 'acme-openai-chat',
            path: '/v1/catalog',
            parser: 'acme-catalog-v3',
          }],
        },
      },
      catalogParsers: {
        'acme-catalog-v3': (body: unknown) => ({
          models: (body as { catalog: readonly { slug: string; title: string; window: number }[] })
            .catalog.map((entry) => ({
              id: entry.slug,
              name: entry.title,
              contextWindowTokens: entry.window,
            })),
        }),
      },
    },
  },
});

const CATALOG_BODY = JSON.stringify({
  catalog: [
    { slug: 'acme/sonnet', title: 'Acme Sonnet', window: 200_000 },
    { slug: 'acme/haiku', title: 'Acme Haiku', window: 64_000 },
  ],
});

describe('externally contributed Provider catalog format', () => {
  it('normalizes Claude catalog labels and preserves advertised reasoning through its declared parser (01E)', async () => {
    const plugin = await createPluginTestkit({ manifest: claudeManifest, module: { activate: CLAUDE_PLUGIN.activate } });
    try {
      const parsers = plugin.registration('providers', 'anthropic')?.catalogParsers;
      expect(parsers).toBeDefined();
      const provider = ProviderContributionV1Schema.parse(claudeManifest.contributes.providers?.find(row => row.id === 'anthropic'));
      if (!('probes' in provider.catalog)) throw new Error('Expected Claude dynamic catalog');
      const result = parseProviderCatalogResponse(provider.catalog.probes[0]!.parser, { data: [{
        id: 'claude-future-6', display_name: 'Claude Future 6', max_input_tokens: 1_000_000,
        capabilities: { effort: { supported: true, high: { supported: true }, xhigh: { supported: true } } },
      }] }, parsers);
      expect(result.models).toEqual([expect.objectContaining({
        id: 'claude-future-6', name: 'Future 6', contextWindowTokens: 1_000_000,
        capabilities: { reasoningControls: 'supported' },
        modelOptions: [expect.objectContaining({ id: 'reasoning_effort', options: [
          { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' },
        ] })],
      })]);
    } finally { await plugin.dispose(); }
  });

  it('preserves native model capabilities, identities and load states through the local Provider declarations (01E)', async () => {
    const ollama = await createPluginTestkit({ manifest: ollamaManifest, module: { activate: activateOllama } });
    const lmstudio = await createPluginTestkit({ manifest: lmstudioManifest, module: { activate: activateLmstudio } });
    try {
      const ollamaParsers = ollama.registration('providers', 'ollama')?.catalogParsers;
      const lmstudioParsers = lmstudio.registration('providers', 'lmstudio')?.catalogParsers;
      expect(ollamaParsers).toBeDefined();
      expect(lmstudioParsers).toBeDefined();
      expect(parseProviderCatalogResponse('ollama-tags', { models: [
        { model: 'coding:latest', capabilities: ['completion', 'tools', 'thinking'] },
        { model: 'embedding:latest', capabilities: ['embedding'] },
      ] }, ollamaParsers).models).toEqual([{ id: 'coding:latest', capabilities: {
        toolRoundTrips: 'supported', reasoningControls: 'supported',
      } }]);
      expect(parseProviderCatalogResponse('lmstudio-native-models', { models: [
        { key: 'coding-model', display_name: 'Coding Model', type: 'llm', loaded_instances: [{}] },
        { key: 'unloaded-model', type: 'llm', loaded_instances: [] },
        { key: 'embedding-model', type: 'embedding' },
      ] }, lmstudioParsers)).toEqual({ models: [
        { id: 'coding-model', name: 'Coding Model' }, { id: 'unloaded-model' },
      ], loadStates: [
        { modelId: 'coding-model', loadState: 'loaded' }, { modelId: 'unloaded-model', loadState: 'unloaded' },
      ] });
      const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool: async () => ({
        ok: true, exitCode: 0, stdout: 'NAME ID SIZE MODIFIED\ncoding:latest abc 4GB now\n', stderr: '',
      }) } });
      const provider = ProviderContributionV1Schema.parse(ollamaManifest.contributes.providers?.[0]);
      if (!provider.discovery?.catalogFallback) throw new Error('Expected Ollama command fallback');
      expect(await fallback.run({ descriptor: provider.discovery.catalogFallback,
        endpointUrl: 'http://127.0.0.1:11434', contributedCatalogParsers: ollamaParsers,
      })).toEqual({ status: 'success', models: [{ id: 'coding:latest', name: 'coding:latest' }] });
    } finally {
      await ollama.dispose();
      await lmstudio.dispose();
    }
  });

  it('dispatches the Gateway plugin parser through activation and the real HTTP catalog consumer', async () => {
    const testkit = await createPluginTestkit({ manifest: vercelManifest, module: { activate: activateVercel } });
    try {
      const parsers = testkit.registration('providers', 'vercel-ai-gateway')?.catalogParsers;
      const provider = ProviderContributionV1Schema.parse(vercelManifest.contributes?.providers?.[0]);
      if (provider.catalog.source !== 'probe') throw new Error('Gateway must declare a probed catalog');
      const probe = provider.catalog.probes[0]!;
      const endpoint = provider.endpointTemplates.find(candidate => candidate.id === probe.endpointTemplateId)!;
      if (!endpoint.baseUrl) throw new Error('Gateway must declare a catalog endpoint URL');
      const requests: string[] = [];
      const client = createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async request => {
          requests.push(request.url);
          return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(vercelCatalog)) };
        },
      });
      const result = await client.getCatalog({ endpointUrl: endpoint.baseUrl, path: probe.path, parser: probe.parser,
        publicHeaders: endpoint.publicHeaders ?? {}, contributedCatalogParsers: parsers, authorizeDestination: async () => {} });
      expect(requests).toEqual(['https://ai-gateway.vercel.sh/v1/models']);
      expect(result.catalog.models.map(model => model.id)).toEqual(['openai/gpt-5', 'anthropic/claude-sonnet-4', 'vmc/team-model']);
      expect(result.catalog.models[0]).toMatchObject({ contextWindowTokens: 400000,
        capabilities: { reasoningControls: 'supported', toolRoundTrips: 'supported' },
        modelOptions: [{ id: 'reasoning_effort', currentValue: 'high' }] });
    } finally {
      await testkit.dispose();
    }
  });

  it('parses a third-party Provider catalog end to end', async () => {
    const testkit = await createPluginTestkit({
      manifest: acmePlugin.manifest,
      module: { activate: acmePlugin.activate },
    });
    const registered = testkit.registration('providers', 'acme');
    await testkit.dispose();

    const contributedCatalogParsers = registered?.catalogParsers;
    expect(contributedCatalogParsers).toBeDefined();
    expect(registered?.managedRuntime).toBeUndefined();

    const transport: ProviderProbeTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(CATALOG_BODY),
    });
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });
    const request = {
      endpointUrl: 'https://api.acme.example/v1',
      path: '/v1/catalog',
      parser: 'acme-catalog-v3',
      publicHeaders: {},
      authorizeDestination: async () => {},
    } as const;

    const result = await client.getCatalog({ ...request, contributedCatalogParsers });
    expect(result.catalog.models).toEqual([
      { id: 'acme/sonnet', name: 'Acme Sonnet', contextWindowTokens: 200_000 },
      { id: 'acme/haiku', name: 'Acme Haiku', contextWindowTokens: 64_000 },
    ]);

    // The same declaration without its contributing plugin reports a typed
    // unavailable rather than reinterpreting the body with a bundled parser.
    await expect(client.getCatalog(request)).rejects.toMatchObject({
      code: 'provider_contribution_unavailable',
    });
  });
});

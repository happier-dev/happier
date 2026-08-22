import { describe, expect, it } from 'vitest';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

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

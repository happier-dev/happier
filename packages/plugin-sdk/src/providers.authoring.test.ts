import { describe, expect, it } from 'vitest';

import type { PluginManifest } from './manifest.js';
import {
  ProviderContributionV1Schema,
  type ProviderContributionV1,
} from './providers.js';

describe('experimental Provider authoring through the public manifest SDK', () => {
  it('authors the same declarative contribution shape used by bundled Providers', () => {
    const provider = {
      v: 1,
      id: 'acme-models',
      name: 'Acme Models',
      kind: 'aggregator',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        required: true,
        transports: [{
          id: 'responses-auth',
          protocols: ['openai-responses'],
          uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        }],
      },
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    } satisfies ProviderContributionV1;

    const manifest = {
      schemaVersion: 2,
      id: 'example.experimental-provider',
      version: '0.1.0',
      displayName: 'Experimental Provider',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: { providers: [provider] },
    } satisfies PluginManifest;

    expect(manifest.contributes.providers).toEqual([provider]);
  });

  it('validates ordinary and managed Provider declarations through the public Provider entrypoint', () => {
    const ordinaryProvider = {
      v: 1,
      id: 'acme-models',
      name: 'Acme Models',
      kind: 'aggregator',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    } as const;

    expect(ProviderContributionV1Schema.parse(ordinaryProvider))
      .not.toHaveProperty('managedRuntime');
    expect(ProviderContributionV1Schema.parse({
      ...ordinaryProvider,
      managedRuntime: {
        kind: 'managed',
        connectedAccounts: [{
          purpose: 'provider.inference',
          service: 'openai',
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'provider.inference',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.openai.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
    })).toMatchObject({
      managedRuntime: {
        kind: 'managed',
        requestAuthUses: [{ purpose: 'provider.inference' }],
        endpointTemplateIds: ['responses'],
      },
    });
    expect(ProviderContributionV1Schema.safeParse({
      ...ordinaryProvider,
      managedRuntime: {
        kind: 'managed',
        connectedAccounts: [],
        requestAuthUses: [{
          purpose: 'provider.inference',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.openai.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
    }).success).toBe(false);
  });
});
